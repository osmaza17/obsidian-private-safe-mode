# CLAUDE.md

Guía para Claude Code al trabajar en este repositorio. Mantener este archivo actualizado conforme
cambie el proyecto.

## Propósito

**Private Safe Mode** es un plugin local de Obsidian que oculta por completo de la interfaz las notas
con `private: true` en su frontmatter mientras el "modo seguro" está **bloqueado** (estado por
defecto al arrancar). Al desbloquear con un atajo + contraseña, las notas privadas reaparecen.

Es **ocultación, NO cifrado**: los `.md` siguen siendo texto plano en disco. Ver `README.md` para el
detalle del alcance y las limitaciones (especialmente del ocultado de backlinks/enlaces/menciones,
que es solo visual).

## Stack

- **TypeScript** compilado con **esbuild** (`esbuild.config.mjs`) a un único `main.js` (CommonJS).
- API de **Obsidian** (`obsidian` en devDependencies; tipos en `node_modules/obsidian/obsidian.d.ts`).
- Sin framework de UI ni tests automatizados (la verificación es manual dentro de Obsidian).

## Estructura

- `main.ts` — **todo el código del plugin** (clase `PrivateSafeModePlugin`, `PasswordModal`,
  `PSMSettingTab`). Es el único fuente; no hay carpeta `src/`.
- `main.js` — **generado** por el build; no editar a mano.
- `manifest.json` — metadatos del plugin para Obsidian (`id`, `version`, `minAppVersion`).
- `styles.css` — CSS estático (estado de barra y clase `.psm-link-hidden`). El CSS dinámico
  (rutas/enlaces privados) se inyecta desde `main.ts` en un `<style>`.
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

## Mecanismo de ocultado (dónde tocar)

Punto central: `applyHiding()` en `main.ts`. Encadena:

1. `applyIgnoreFilters()` — añade/quita rutas privadas de `userIgnoreFilters` vía
   `vault.getConfig/setConfig` (API no documentada). Cubre búsqueda nativa, switcher, grafo y
   autocompletado de enlaces. El registro de lo añadido se **persiste** en `settings.managedFilters`
   (`data.json`) para poder revertirlo aunque Obsidian se cierre/crashee estando bloqueado.
2. `applyExplorerHiding()` — inyecta un `<style>` que oculta del explorador las notas privadas, los
   enlaces internos en el texto (`a.internal-link[data-href]`) y los embeds (`.internal-embed[src]`)
   que apuntan a ellas.
3. `applyLinkPanes()` — `MutationObserver` que oculta las entradas privadas en los paneles
   `.backlink-pane` y `.outgoing-link-pane` (backlinks, enlaces salientes, menciones). Está acotado a
   `workspace.containerEl` y a mutaciones de esos paneles (`mutationAffectsLinkPane`) para no escanear
   al teclear. El match es por **basename**, por lo que dos notas con el mismo nombre se ocultan
   juntas (decisión consciente: ocultar de más antes que filtrar una privada).
4. `closePrivateLeaves()` — cierra (`detach`) cualquier hoja que tuviera abierta una nota privada.
5. `refreshOmnisearch()` — intenta reindexar Omnisearch si su API está disponible.

`guardOpen()` (evento `file-open`) impide abrir notas privadas mientras está bloqueado.
`guardHover` (listener `mouseover` en captura sobre `document`) bloquea la vista previa al pasar el
ratón sobre enlaces/embeds a notas privadas (best-effort; en Live Preview el destino no siempre es
legible desde el DOM).

El conjunto de notas privadas se mantiene en `privatePaths` (+ `privateNames` / `privatePathsNoExt`
derivados) y se reconstruye en `rebuildPrivateSet()` al detectar cambios de metadatos/rename/delete.

## Convenciones

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
