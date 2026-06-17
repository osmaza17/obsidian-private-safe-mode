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

## Como se usa

1. Marca las notas con la propiedad `private` (tipo checkbox) en `true`:
   ```yaml
   ---
   private: true
   ---
   ```
2. En los ajustes del plugin, define una contrasena.
3. (Recomendado) Asigna un atajo de teclado al comando **"Alternar modo seguro"** en
   Ajustes > Hotkeys. Nota: el atajo es visible en esos ajustes, asi que no es secreto por si solo;
   el secreto real es la contrasena.
4. Por defecto el modo esta bloqueado: las notas privadas no aparecen en el explorador, ni en la
   busqueda, ni en el switcher, ni en el grafo, ni en Omnisearch, y no se pueden abrir. Tampoco
   aparecen en los paneles de **vinculos a esta nota (backlinks)**, **enlaces salientes** ni
   **menciones sin enlazar**; los enlaces `[[...]]` y los **embeds `![[...]]`** que apuntan a ellas se
   ocultan del texto de otras notas; no se muestra su **vista previa al pasar el raton**; y si una
   nota privada estaba **abierta en una pestana**, se cierra al bloquear (ver el apartado siguiente
   sobre el alcance de esto).
5. Pulsa el atajo (o el candado de la barra de estado) e introduce la contrasena para mostrarlas.
   Vuelve a pulsar para ocultarlas (bloquear no pide contrasena).

## Omnisearch

Para que Omnisearch deje de devolver las notas privadas, activa en sus ajustes
**"Respect Obsidian's Excluded Files"**. Aun asi, Omnisearch mantiene un indice en cache propio:
una nota ya indexada puede seguir apareciendo hasta que se reindexe (puede requerir reiniciar
Obsidian o limpiar la cache de Omnisearch). El plugin intenta forzar un reindexado via la API de
Omnisearch si esta disponible, pero ese metodo no esta garantizado entre versiones.

## Backlinks, enlaces salientes y menciones: alcance del ocultado

Estas superficies se ocultan **solo de forma visual** (CSS + recorrido del DOM), no eliminando los
datos. Esto es importante:

- En los paneles de backlinks, enlaces salientes y menciones, el plugin recorre las entradas
  renderizadas y oculta las que corresponden a una nota privada (las casa por **nombre de archivo**).
  Consecuencia: si tienes dos notas con el **mismo nombre** y una es privada, la otra tambien quedara
  oculta en esos paneles mientras este bloqueado (se prefiere ocultar de mas a filtrar una privada).
- Los enlaces `[[...]]` a notas privadas se ocultan del texto via CSS en **vista lectura / preview**.
  En **Live Preview** (modo edicion) el match es menos fiable porque Obsidian no expone ahi el destino
  del enlace de forma estable; ese caso puede no ocultarse siempre.
- El `metadataCache` de Obsidian **sigue conociendo** las notas privadas. Otros plugins (Dataview,
  etc.) o casos limite podrian seguir viendolas. Para eliminacion real a nivel de datos haria falta
  interceptar las APIs internas de Obsidian, lo cual no se hace en esta version.

## Mecanismo (resumen tecnico)

- Mantiene en memoria el conjunto de rutas con `private: true` (y sus nombres derivados), actualizado
  al vuelo.
- Cuando esta bloqueado:
  - Anade esas rutas a `userIgnoreFilters` (la lista "Archivos excluidos" de Obsidian, via la API no
    documentada `vault.getConfig/setConfig`) -> busqueda nativa, switcher, grafo, autocompletado. El
    registro de lo que anade se **persiste en `data.json`** (`managedFilters`), para poder revertirlo
    aunque Obsidian se cierre o crashee estando bloqueado (si no, esas rutas quedarian excluidas para
    siempre).
  - Inyecta un `<style>` que oculta las notas del explorador, los enlaces internos (`a.internal-link`
    por `data-href`) y los embeds (`.internal-embed` por `src`) que apuntan a ellas.
  - Activa un `MutationObserver` (acotado al area de trabajo y a las mutaciones de los paneles de
    enlaces, para no recalcular al teclear) que oculta las entradas privadas en los paneles
    `.backlink-pane` y `.outgoing-link-pane` (backlinks, enlaces salientes y menciones sin enlazar).
  - Intercepta `file-open` para impedir abrirlas y cierra (`detach`) las hojas que ya tuvieran una
    nota privada abierta.
  - Intercepta el `mouseover` (en captura) para bloquear la vista previa al pasar el raton sobre
    enlaces/embeds a notas privadas (best-effort; en Live Preview el destino no siempre es legible).
- Al desbloquear: revierte todo (quita solo lo que el plugin habia anadido, sin tocar las
  exclusiones propias del usuario; desconecta el observer y limpia las clases de ocultado).
- Arranca **siempre bloqueado**: el desbloqueo no persiste entre reinicios.

## Build

```bash
npm install
npm run build   # genera main.js
npm run dev     # build en modo watch
```

Tras compilar, activa el plugin en Ajustes > Complementos de la comunidad (o recargalo).
