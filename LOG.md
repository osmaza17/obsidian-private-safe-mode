# LOG

Registro de cambios del plugin Private Safe Mode. Lo mas reciente arriba.

## 2026-06-19

- **Solo tinte amarillo al activar el modo privado; nada al desactivarlo.** Se elimina por completo
  el estado rojo (`psm-unlocked`): cuando el modo privado esta DESACTIVADO no se aplica ninguna regla
  y las ventanas flotantes quedan con su apariencia por defecto. Cuando esta ACTIVO (`psm-locked`) se
  aplica solo un tinte amarillo ligero, sin bordes ni banda de aviso. El tinte usa `background-image`
  (capa amarilla plana) en vez de `background-color` para sumarse al fondo existente y no pisar el
  fondo opaco del snippet de opacidad ni reintroducir transparencia.
- **Tinte amarillo suavizado y sin banda de texto.** Se quita el borde grueso + halo del estado
  bloqueado y tambien la banda "MODO PRIVADO ACTIVO"; ahora es solo un fondo amarillo translucido
  ligero (`rgba(224,168,0,.07)` en `.prompt`, `.1` en el input-container). El estado rojo
  (desbloqueado) conserva su borde fuerte + banda a proposito (es el estado en que las privadas SI
  se ven).
- **Tinte amarillo del estado "modo privado activo" + arreglo del selector.** El estado bloqueado
  pasa de una fina banda verde a un aviso AMARILLO prominente (borde + banda "MODO PRIVADO ACTIVO"),
  igual de visible que el aviso rojo del estado desbloqueado. **Bug encontrado:** el tinte apuntaba a
  `.omnisearch-modal`, pero el atajo Ctrl+O del usuario abre el **Quick Switcher nativo** (clase
  `.prompt`), no el Vault search de Omnisearch, asi que NUNCA se veia (ni el rojo ni el verde/amarillo).
  Se cambia el selector a `.prompt` (cubre switcher nativo, paleta de comandos y Omnisearch) y la
  banda a `.prompt-input-container` / `.omnisearch-input-container`. Cambio solo en `styles.css`; no
  requiere recompilar, pero si recargar el plugin porque Obsidian cachea `styles.css`.
- **Archivos privados por nombre (ajuste nuevo).** Se anade `settings.privateFiles` (lista). Ademas
  de las notas con el campo de frontmatter, ahora se pueden marcar archivos como privados a mano
  desde los ajustes, por nombre (basename, con o sin `.md`) o por ruta. Match sin distinguir
  mayusculas/minusculas y sin la extension `.md` (`manualPrivateKeys` / `matchesManual`, usados en
  `rebuildPrivateSet`). UI en `PSMSettingTab`: caja de texto + boton "Anadir" y lista de entradas
  con boton de borrar; cada cambio reconstruye el conjunto privado, reaplica el ocultado y refresca
  el contador.
- **Indicador visual del estado en Omnisearch.** `updateBodyState()` pone en el `<body>` la clase
  `psm-unlocked` (privadas visibles) o `psm-locked` (ocultas). `styles.css` usa esas clases para
  tenir el modal `.omnisearch-modal`: borde rojo + aviso cuando esta desbloqueado, banda verde fina
  cuando esta bloqueado. Se hace SIN tocar el plugin de Omnisearch (sus actualizaciones no se
  rompen; si renombra `.omnisearch-modal`, el tinte solo deja de aplicarse). Limpieza de las clases
  en `onunload`.
