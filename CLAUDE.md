# CLAUDE.md

Guía para Claude Code al trabajar en este repositorio. Mantener este archivo actualizado conforme
cambie el proyecto.

## Propósito

**Private Safe Mode** es un plugin local de Obsidian que oculta por completo de la interfaz las notas
con `Private: true` en su frontmatter (el nombre del campo es configurable en ajustes
—`settings.privateField`, por defecto `private`— y se detecta sin distinguir mayúsculas/minúsculas;
ver `isPrivate`) mientras el "modo seguro" está **bloqueado** (estado por
defecto al arrancar). Al desbloquear con un atajo + contraseña, las notas privadas reaparecen.

Es **ocultación, NO cifrado**: los `.md` siguen siendo texto plano en disco. Ver `README.md` para el
detalle del alcance y las limitaciones (especialmente del ocultado de backlinks/enlaces/menciones,
que es solo visual).

## Stack

- **TypeScript** compilado con **esbuild** (`esbuild.config.mjs`) a un único `main.js` (CommonJS).
- API de **Obsidian** (`obsidian` en devDependencies; tipos en `node_modules/obsidian/obsidian.d.ts`).
- **CodeMirror 6** (`@codemirror/state`, `@codemirror/view`) para la censura en el editor. Van marcados
  como **external** en `esbuild.config.mjs` (Obsidian los provee en runtime); si se empaquetaran, las
  decoraciones usarían otra instancia de CM6 y no aplicarían.
- Sin framework de UI ni tests automatizados (la verificación es manual dentro de Obsidian).

## Estructura

- `main.ts` — **todo el código del plugin** (clase `PrivateSafeModePlugin`, `PasswordModal`,
  `PSMSettingTab`, y la extensión de editor `CensorEditorWidget` + `buildCensorEditorExtension`). Es el
  único fuente; no hay carpeta `src/`.
- `main.js` — **generado** por el build; no editar a mano.
- `manifest.json` — metadatos del plugin para Obsidian (`id`, `version`, `minAppVersion`).
- `styles.css` — CSS estático (estado de barra, `.psm-link-hidden`, y `.psm-censored-cm` del widget de
  censura del editor). El CSS dinámico (rutas/enlaces privados, censura en lectura) se inyecta desde
  `main.ts` en un `<style>`.
- `esbuild.config.mjs` — configuración de build (modo `production` vs watch).
- `README.md` — documentación de usuario; mantener fiel a lo que hace el código.

## Comandos

```bash
npm install        # dependencias
npm run dev        # build en modo watch
npm run build      # build de producción -> genera main.js
npx tsc --noEmit   # type-check (esbuild NO comprueba tipos)
```

Tras compilar, recargar el plugin en Obsidian (o reiniciar) para probar.

## Instalación en un vault (manual)

Obsidian solo carga plugins desde `<vault>/.obsidian/plugins/<id>/`. Para instalarlo/actualizarlo:

1. Compilar (`npm run build`).
2. Copiar **`main.js`, `manifest.json` y `styles.css`** a `<vault>/.obsidian/plugins/private-safe-mode/`.
   (Opcional: `data.json` para conservar la contraseña/ajustes ya configurados.)
3. Activarlo en Ajustes → Complementos de la comunidad. Si ya estaba activo, recargarlo
   (desactivar/activar) para cargar el nuevo `main.js`.

`@codemirror/state` y `@codemirror/view` NO se copian: Obsidian los provee en runtime (van como
`external` en el build, ver Stack).

## Replicar desde cero (resumen)

Un plugin mínimo de Obsidian: `manifest.json` (id/version/minAppVersion), `main.ts` con
`export default class extends Plugin`, build con esbuild a `main.js` (CommonJS, `obsidian` y
`@codemirror/*` como `external`). La lógica entera vive en `main.ts` (ver "Estructura" y "Mecanismo").
Los "knobs" ajustables están como constantes al principio de `main.ts`:

- `CENSOR_CHAR` (`■`) — glifo de censura.
- Factor de tamaño del cuadrado: `* 1.6` en `applyExplorerHiding` (CSS de lectura) y en
  `styles.css` (`.psm-censored-cm`, editor). **Cambiar ambos a la vez** para que lectura y editor
  coincidan.
- `settings.privateField` (por defecto `private`) — campo de frontmatter, configurable en ajustes.

## Mecanismo de ocultado (dónde tocar)

Punto central: `applyHiding()` en `main.ts`. Encadena:

1. `applyIgnoreFilters()` — añade/quita rutas privadas de `userIgnoreFilters` vía
   `vault.getConfig/setConfig` (API no documentada). Cubre búsqueda nativa, switcher, grafo,
   autocompletado de enlaces **y las Bases nativas** (las Bases también respetan "Archivos
   excluidos", así que las notas privadas no aparecen en ninguna Base mientras está bloqueado;
   reaparecen al desbloquear). El registro de lo añadido se **persiste** en
   `settings.managedFilters` (`data.json`) para poder revertirlo aunque Obsidian se cierre/crashee
   estando bloqueado. **Red de seguridad anti-huérfanos:** al calcular qué quitar, se consideran
   "gestionadas por el plugin" tanto `managedFilters` como las rutas privadas **actuales**
   (`privatePaths`). Así, aunque `managedFilters` se pierda o desincronice (versión antigua,
   `data.json` viejo, cierre sin `onunload`, crash), las exclusiones de notas privadas se limpian
   igualmente y no quedan huérfanas para siempre. Compromiso: si el usuario había excluido a mano
   una nota que ahora es privada, esa exclusión pasa a gestionarla el plugin (reaparece al
   desbloquear).
2. `applyExplorerHiding()` — inyecta un `<style>` que (a) oculta del explorador las notas privadas, y
   (b) **censura** (no oculta) tanto los enlaces internos (`a.internal-link`) como los embeds
   (`.internal-embed`) a notas privadas: en el enlace colapsa el texto original (`font-size: 0` +
   `color: transparent`), en el embed oculta el contenido embebido (`> *`), y en ambos pinta con un
   `::after` la cadena de la variable CSS `--psm-censor` (con `pointer-events: none` para dejarlos
   inertes). Como CSS no puede contar caracteres, qué censurar y con cuántos cuadrados lo decide
   `markCensorable()` en JS: marca el elemento (`psm-censored-link` / `psm-censored-embed`) y rellena
   `--psm-censor` con un `CENSOR_CHAR` (`■`) por carácter no-espacio (longitud proporcional al **texto
   visible** del enlace, o al **nombre** de la nota embebida en el embed; no a su contenido). El
   tamaño del cuadrado se escala vía CSS (`calc(var(--font-text-size) * 1.6)`). `markCensorable` se
   invoca desde un `registerMarkdownPostProcessor` (onload, para lo que se renderiza después) y desde
   `applyExplorerHiding`, que lo aplica **solo sobre los contenedores de lectura
   `.markdown-preview-view`** (NUNCA sobre `workspace.containerEl` entero, que incluiría el editor CM).
   Casa por destino (`data-href` / `src`), así que censura también enlaces con alias. En el editor
   actúa la extensión de CodeMirror (ver abajo).
3. **Censura en el editor** — dos mecanismos según el caso, porque en Live Preview Obsidian
   renderiza el embed como widget de BLOQUE y una decoración inline de CodeMirror no llega:
   - **Enlaces `[[...]]` (LP + Source) y embeds `![[...]]` (solo Source)**: extensión
     `buildCensorEditorExtension` (un `ViewPlugin` de CM6 registrado con `Prec.highest`) que recorre
     el texto visible, detecta destinos privados (`isPrivateLinktext`) y los reemplaza por un
     `CensorEditorWidget` (clase `.psm-censored-cm`, en `styles.css`). NO censura lo que tenga el
     cursor encima (para editarlo). En Live Preview NO censura embeds (`editorLivePreviewField`),
     para no solaparse con el DOM. Refresco al bloquear/desbloquear via `StateEffect`
     `psmCensorRefresh` (`refreshEditorCensor`).
   - **Embeds `![[...]]` en Live Preview**: por DOM/CSS, igual que en lectura. `markEditorEmbeds`
     marca los `.internal-embed` dentro de `.markdown-source-view` con `.psm-censored-embed` (regla
     ya inyectada por `applyExplorerHiding`). Se mantiene fresco con el `MutationObserver`
     (`mutationAddsEmbed` → `scheduleEmbedScan`), porque los embeds en LP se renderizan al hacer
     scroll.
4. `applyLinkPanes()` — `MutationObserver` que oculta las entradas privadas en los paneles
   `.backlink-pane` y `.outgoing-link-pane` (backlinks, enlaces salientes, menciones). Está acotado a
   `workspace.containerEl` y a mutaciones de esos paneles (`mutationAffectsLinkPane`) para no escanear
   al teclear. El match es por **basename**, por lo que dos notas con el mismo nombre se ocultan
   juntas (decisión consciente: ocultar de más antes que filtrar una privada).
5. `closePrivateLeaves()` — cierra (`detach`) cualquier hoja que tuviera abierta una nota privada.
6. `refreshOmnisearch()` — intenta reindexar Omnisearch si su API está disponible.
7. `refreshEditorCensor()` — despacha `psmCensorRefresh` a los editores para recalcular la censura.

`refreshGraphViews()` (llamado desde `applyIgnoreFilters`, **solo cuando `userIgnoreFilters` cambia
de verdad**, no en cada `layout-change`, y en `onLayoutReady` al arrancar) fuerza a las vistas de
grafo a recomputar (`view.dataEngine/engine.render()`). El grafo respeta "Archivos excluidos" pero no
se entera solo del cambio (solo recomputa ante ciertos eventos: de ahí que al pulsar un nodo privado
el grafo "se resetee" y el nodo desaparezca). Best-effort/API interna; solo re-renderiza (no persiste,
no toca notas); degrada a no-op si la API cambia.

`guardOpen()` (evento `file-open`) impide abrir notas privadas mientras está bloqueado.
`guardHover` (listener `mouseover` en captura sobre `document`) bloquea la vista previa al pasar el
ratón sobre enlaces/embeds a notas privadas (best-effort; en Live Preview el destino no siempre es
legible desde el DOM).

El conjunto de notas privadas se mantiene en `privatePaths` (+ `privateNames` / `privatePathsNoExt`
derivados) y se reconstruye en `rebuildPrivateSet()` al detectar cambios de metadatos/rename/delete.

## Convenciones

- **INVARIANTE DE SEGURIDAD (innegociable)**: el plugin NUNCA edita el contenido real de las notas.
  La censura/ocultado es siempre de PRESENTACIÓN. Prohibido `vault.modify/process/create/append`,
  `editor.replaceRange/replaceSelection/setLine`, `insertText` o cualquier `dispatch({changes})`. A
  CodeMirror solo se le despachan `effects` (`psmCensorRefresh`); los widgets de censura son
  decoraciones de reemplazo (átomos de vista), no tocan el documento. Lo único que el plugin escribe
  en disco es su `data.json` y la clave `userIgnoreFilters` de la config (nunca un `.md`). Verificable
  con grep de esas APIs antes de cada release.
- La censura de lectura (`markCensorable`) solo se aplica sobre contenedores `.markdown-preview-view`
  (lectura), NUNCA sobre el editor; el editor lo cubre la extensión de CodeMirror. No barrer
  `workspace.containerEl` entero con `markCensorable` (mete clases en el DOM de CM y causa flicker).
- Comentarios y mensajes de UI en **español** (sin acentos en algunos comentarios por compatibilidad
  histórica del archivo; no es obligatorio quitarlos).
- Todo lo que el plugin oculta debe ser **reversible** al desbloquear y al `onunload()`: si añades un
  mecanismo nuevo de ocultado, añade su limpieza en la rama `unlocked`/`onunload`.
- No se modifican archivos del vault en disco; el plugin solo manipula la interfaz y la config.
- APIs internas/no documentadas de Obsidian: usarlas de forma **defensiva** (comprobar que existen) y
  documentarlas, porque pueden cambiar entre versiones.
- Arranca **siempre bloqueado**; el desbloqueo no persiste entre reinicios.

## Verificación manual

No hay tests. Para validar cambios: compilar, recargar en Obsidian y comprobar con notas reales que,
bloqueado, las notas privadas no aparecen en explorador / búsqueda / switcher / grafo / backlinks /
enlaces salientes / menciones / enlaces en texto, y que al desbloquear reaparecen todas. Revisar la
consola (`[private-safe-mode]`) por warnings.
