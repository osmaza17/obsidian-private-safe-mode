# Private Safe Mode

Plugin local de Obsidian para separar lo profesional de lo muy personal en el mismo vault.

Cualquier nota con `private: true` en su frontmatter desaparece por completo de la interfaz
mientras el "modo seguro" esta **bloqueado** (estado por defecto al arrancar Obsidian). Al
desbloquear con un atajo + contrasena, las notas privadas reaparecen en todos los sitios.

## Aviso importante: ocultacion, NO cifrado

Esto **oculta**, no protege de verdad. Las notas privadas siguen siendo archivos `.md` en texto
plano en el disco. Cualquiera puede:

- abrirlas con el Explorador de Windows o cualquier editor de texto,
- desactivar este plugin desde los ajustes de Obsidian y verlas,
- leerlas desde otros plugins (Dataview, document-chat, el terminal de Claude Code Harness, etc.).

La contrasena solo "cierra con llave" la interfaz de Obsidian frente a un vistazo casual. Para
proteccion real frente a otra persona con acceso al equipo, hace falta **cifrar** el contenido (ver
el anexo del plan, no implementado en esta version).

## Garantia: el plugin NUNCA edita el contenido de las notas

Toda la ocultacion/censura es **de presentacion**, nunca modifica los `.md`:

- En el editor, la censura son **decoraciones de CodeMirror** (widgets de reemplazo, solo vista). El
  plugin solo despacha `effects` a CodeMirror, **nunca `changes`**, asi que el documento no cambia.
- En vista lectura, solo se anaden clases CSS y variables al **DOM renderizado** (que no es el
  archivo).
- No se usa ninguna API de escritura de notas (`vault.modify/process/create/append`,
  `editor.replaceRange/setLine`, etc.).
- Lo unico que el plugin escribe en disco es su propio `data.json` (ajustes) y la clave
  `userIgnoreFilters` de la config de Obsidian. **Ningun `.md` se toca.**

Verificable con `grep` de esas APIs antes de cada release (ver `CLAUDE.md` > Convenciones).

## Como se usa

1. Marca las notas con la propiedad `Private` (tipo checkbox) en `true`. El nombre del campo se
   detecta **sin distinguir mayusculas/minusculas** (`Private`, `private`, `PRIVATE` valen igual) y
   es **configurable** en los ajustes del plugin (campo "Campo de frontmatter para notas privadas";
   por defecto `private`), por si prefieres usar otra propiedad como `nsfw`:
   ```yaml
   ---
   Private: true
   ---
   ```
   También puedes marcar archivos como privados **sin tocar su frontmatter**: en los ajustes, en
   **"Archivos privados por nombre"**, añade el nombre del archivo (con o sin `.md`) o su ruta dentro
   del vault. Cada entrada se compara sin distinguir mayúsculas/minúsculas y se suma al criterio del
   frontmatter. Útil para ocultar notas a las que no quieres (o no puedes) añadirles la propiedad.
2. En los ajustes del plugin, define una contrasena.
3. (Recomendado) Asigna un atajo de teclado al comando **"Alternar modo seguro"** en
   Ajustes > Hotkeys. Nota: el atajo es visible en esos ajustes, asi que no es secreto por si solo;
   el secreto real es la contrasena.
4. Por defecto el modo esta bloqueado: las notas privadas no aparecen en el explorador, ni en la
   busqueda, ni en el switcher, ni en el grafo, ni en las Bases nativas, ni en Omnisearch, y no se
   pueden abrir. Tampoco
   aparecen en los paneles de **vinculos a esta nota (backlinks)**, **enlaces salientes** ni
   **menciones sin enlazar**; tanto los enlaces `[[...]]` como los **embeds `![[...]]`** que apuntan a
   ellas aparecen **censurados** en el texto de otras notas (una barra continua de bloques `███` en
   lugar del enlace o del contenido embebido; longitud proporcional al texto del enlace o al nombre de
   la nota embebida); no se muestra su **vista previa al pasar el raton**; y si una
   nota privada estaba **abierta en una pestana**, se cierra al bloquear (ver el apartado siguiente
   sobre el alcance de esto).
5. Pulsa el atajo (o el candado de la barra de estado) e introduce la contrasena para mostrarlas.
   El desbloqueo es **automatico**: en cuanto la contrasena tecleada es correcta el modal se cierra
   y las notas privadas reaparecen, sin pulsar "Desbloquear" ni Enter (que siguen disponibles).
   Mientras sea incorrecta no pasa nada y puedes seguir escribiendo. Vuelve a pulsar el atajo para
   ocultarlas (bloquear no pide contrasena).

## Bases nativas

Las **Bases** de Obsidian respetan la lista "Archivos excluidos" (`userIgnoreFilters`). Como el
plugin mete ahi las notas privadas mientras esta bloqueado, esas notas **no apareceran en ninguna
Base** (ni en sus vistas que las filtren, p. ej. por una propiedad `MOCs`) hasta que desbloquees.
Al desbloquear reaparecen. Esto es intencional.

Aviso historico: una version anterior del plugin podia dejar esas rutas excluidas **de forma
permanente** si se perdia el registro `managedFilters` (al desactivar el plugin con un `data.json`
antiguo, o tras un cierre sin `onunload`). El sintoma era que las notas seguian sin aparecer en las
Bases (ni en busqueda) aun con el plugin desactivado. Ya esta corregido: ahora la limpieza tambien
cubre las rutas privadas actuales, no solo el registro. Si todavia tienes exclusiones huerfanas de
aquella version, vacia "Ajustes > Archivos y enlaces > Archivos excluidos".

## Omnisearch

Para que Omnisearch deje de devolver las notas privadas, activa en sus ajustes
**"Respect Obsidian's Excluded Files"**. Aun asi, Omnisearch mantiene un indice en cache propio:
una nota ya indexada puede seguir apareciendo hasta que se reindexe (puede requerir reiniciar
Obsidian o limpiar la cache de Omnisearch). El plugin intenta forzar un reindexado via la API de
Omnisearch si esta disponible, pero ese metodo no esta garantizado entre versiones.

**Indicador visual del estado**: cuando el modo privado esta **activo** (notas privadas ocultas), las
ventanas flotantes de busqueda se tiñen de un **amarillo ligero**, para recordarte de un vistazo que
la busqueda esta filtrada y no salen todos los resultados. Cuando el modo privado esta **desactivado**
no se aplica ningun cambio: las ventanas quedan con su apariencia por defecto (sin bordes ni avisos).
Funciona con el **Quick Switcher nativo** (Ctrl+O), la **paleta de comandos** (Ctrl+P) y el **Vault
search de Omnisearch**, porque el CSS apunta a la clase `.prompt` de Obsidian (comun a los tres). Se
hace 100% desde este plugin (una clase `psm-locked` en el `<body>` + CSS), **sin modificar Omnisearch
ni Obsidian**; si Obsidian renombrara `.prompt`, el tinte simplemente dejaria de mostrarse.

## Backlinks, enlaces salientes y menciones: alcance del ocultado

Estas superficies se ocultan **solo de forma visual** (CSS + recorrido del DOM), no eliminando los
datos. Esto es importante:

- En los paneles de backlinks, enlaces salientes y menciones, el plugin recorre las entradas
  renderizadas y oculta las que corresponden a una nota privada (las casa por **nombre de archivo**).
  Consecuencia: si tienes dos notas con el **mismo nombre** y una es privada, la otra tambien quedara
  oculta en esos paneles mientras este bloqueado (se prefiere ocultar de mas a filtrar una privada).
- Los enlaces `[[...]]` a notas privadas se **censuran** en el texto: se reemplazan por una barra
  continua de bloques `█` (uno por cada caracter, espacios incluidos, sin huecos; longitud
  proporcional), y quedan inertes. Funciona
  aunque el enlace use un alias (`[[nota|otro texto]]`), porque se casa por el destino, no por el texto
  visible (en ese caso la longitud corresponde al alias). Hay **dos mecanismos** segun la vista:
  - **Vista lectura / preview**: como CSS no puede contar caracteres, un post-procesador de Markdown
    marca el enlace y guarda la cadena de bloques en `--psm-censor`; el CSS solo la pinta mientras
    esta bloqueado.
  - **Editor (Live Preview y Source mode)**: ahi los enlaces no son `<a>` del DOM, asi que se usa una
    extension de CodeMirror que recorre el texto visible, detecta los `[[...]]`/`![[...]]` a notas
    privadas y los reemplaza por un widget con la censura. Para poder editarlos, **el enlace sobre el
    que esta el cursor NO se censura** (muestra el texto crudo), igual que Live Preview revela la
    sintaxis al entrar en ella. Es best-effort: en Live Preview, Obsidian tambien decora los enlaces
    por su cuenta y nuestra decoracion se solapa con la suya; conviene probarlo entre versiones.
- Los **embeds `![[...]]`** a notas privadas se censuran igual (no se ocultan), con la censura
  proporcional al **nombre** de la nota embebida (no a su contenido, que seria enorme). El mecanismo
  depende de la vista, porque en Live Preview Obsidian renderiza el embed como bloque y la decoracion
  de CodeMirror no llega:
  - **Vista lectura y Live Preview**: se oculta el contenido embebido y se pinta la censura por
    DOM/CSS (se marca el `.internal-embed` renderizado).
  - **Source mode**: se reemplaza el texto `![[...]]` por el widget de censura (via CodeMirror).
- El `metadataCache` de Obsidian **sigue conociendo** las notas privadas. Otros plugins (Dataview,
  etc.) o casos limite podrian seguir viendolas. Para eliminacion real a nivel de datos haria falta
  interceptar las APIs internas de Obsidian, lo cual no se hace en esta version.

## Mecanismo (resumen tecnico)

- Mantiene en memoria el conjunto de rutas con `private: true` (y sus nombres derivados), actualizado
  al vuelo.
- Cuando esta bloqueado:
  - Anade esas rutas a `userIgnoreFilters` (la lista "Archivos excluidos" de Obsidian, via la API no
    documentada `vault.getConfig/setConfig`) -> busqueda nativa, switcher, grafo, autocompletado y
    **las Bases nativas** (ver la nota de abajo). El registro de lo que anade se **persiste en
    `data.json`** (`managedFilters`), para poder revertirlo aunque Obsidian se cierre o crashee
    estando bloqueado. Ademas, al revertir se tratan como propias tanto `managedFilters` como las
    rutas privadas actuales, de modo que **nunca quedan exclusiones huerfanas** aunque ese registro
    se pierda o desincronice (version antigua, `data.json` viejo, cierre sin `onunload`).
  - Inyecta un `<style>` que oculta las notas del explorador y **censura** los enlaces internos
    (`a.internal-link`) y los embeds (`.internal-embed`) a notas privadas EN VISTA LECTURA: en el
    enlace colapsa el texto original (`font-size: 0` + `color: transparent`), en el embed oculta el
    contenido embebido (`> *`), y en ambos pinta con un `::after` la cadena de bloques de la
    variable `--psm-censor` (que rellena el post-procesador de Markdown via `markCensorable`, un `█`
    por caracter), dejando el elemento inerte (`pointer-events: none`).
  - Registra una **extension de CodeMirror** (`registerEditorExtension`) que censura los
    `[[...]]`/`![[...]]` a notas privadas EN EL EDITOR (Live Preview y Source mode), reemplazandolos
    por un widget con la barra de cuadrados, salvo el que tenga el cursor (para poder editarlo). Al
    bloquear/desbloquear se refresca via un `StateEffect` (`psmCensorRefresh`).
  - Activa un `MutationObserver` (acotado al area de trabajo y a las mutaciones de los paneles de
    enlaces, para no recalcular al teclear) que oculta las entradas privadas en los paneles
    `.backlink-pane` y `.outgoing-link-pane` (backlinks, enlaces salientes y menciones sin enlazar).
  - Intercepta `file-open` para impedir abrirlas y cierra (`detach`) las hojas que ya tuvieran una
    nota privada abierta.
  - Intercepta el `mouseover` (en captura) para bloquear la vista previa al pasar el raton sobre
    enlaces/embeds a notas privadas (best-effort; en Live Preview el destino no siempre es legible).
  - **Fuerza al grafo a recomputar** (`refreshGraphViews`) justo cuando cambia `userIgnoreFilters`.
    El grafo SI respeta "Archivos excluidos", pero no se entera solo del cambio: solo recomputa sus
    nodos ante ciertos eventos (por eso, sin esto, los nodos privados seguian apareciendo hasta que
    interactuabas con el grafo). Usa la API interna del motor del grafo (`dataEngine.render()`),
    best-effort; si no esta disponible, degrada a no-op (el grafo recomputaria al interactuar).
- Al desbloquear: revierte todo (quita solo lo que el plugin habia anadido, sin tocar las
  exclusiones propias del usuario; desconecta el observer y limpia las clases de ocultado).
- Arranca **siempre bloqueado**: el desbloqueo no persiste entre reinicios.

## Build e instalacion

```bash
npm install
npm run build   # genera main.js (produccion)
npm run dev     # build en modo watch
npx tsc --noEmit # type-check (esbuild NO comprueba tipos)
```

Para instalarlo en un vault, Obsidian carga los plugins desde
`<vault>/.obsidian/plugins/<id>/`. Copia ahi **`main.js`, `manifest.json` y `styles.css`**
(opcionalmente `data.json` para conservar contrasena/ajustes). Luego activalo en
**Ajustes > Complementos de la comunidad**; si ya estaba activo, recargalo (desactivar/activar) para
cargar el nuevo `main.js`.

`@codemirror/state` y `@codemirror/view` NO se copian: Obsidian los provee en runtime (van marcados
como `external` en `esbuild.config.mjs`; si se empaquetaran, las decoraciones del editor usarian otra
instancia de CodeMirror y no aplicarian).

### Ajustes "knob" (para tunear)

- **Tamano de la barra de censura**: factor `* 1.6` en `applyExplorerHiding` (CSS de lectura,
  `main.ts`) y en `.psm-censored-cm` (`styles.css`, editor). Cambia **ambos a la vez** para que
  lectura y editor coincidan.
- **Glifo de censura**: constante `CENSOR_CHAR` (`█`, FULL BLOCK; barra continua con
  `letter-spacing: 0`) al principio de `main.ts`. `censorString` pone un bloque por cada caracter
  (espacios incluidos) para que no haya huecos entre palabras.
- **Campo de frontmatter**: ajuste "Campo de frontmatter para notas privadas" (por defecto
  `private`), comparado sin distinguir mayusculas.
- **Archivos privados por nombre**: ajuste "Archivos privados por nombre" (`settings.privateFiles`).
  Lista de nombres/rutas que se ocultan ademas de las del frontmatter; match sin distinguir
  mayusculas y sin la extension `.md`.
- **Tinte del modal de Omnisearch**: reglas `body.psm-unlocked`/`body.psm-locked` en `styles.css`
  (colores via variables del tema `--color-red`/`--color-green`). La clase del `<body>` la pone
  `updateBodyState()` en `main.ts`.
