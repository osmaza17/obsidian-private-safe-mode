import {
  App,
  editorLivePreviewField,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/**
 * Private Safe Mode
 * -----------------
 * Oculta por completo las notas marcadas con `private: true` en su frontmatter
 * mientras el "modo seguro" esta bloqueado (estado por defecto al arrancar).
 * Al desbloquear (atajo + contrasena) las notas reaparecen en toda la interfaz.
 *
 * IMPORTANTE: esto es OCULTACION, no cifrado. Los .md siguen siendo texto plano
 * en disco; cualquiera puede abrirlos fuera de Obsidian o desactivar el plugin.
 */

interface PSMSettings {
  // Nombre del campo de frontmatter que marca una nota como privada (NSFW). Se compara sin
  // distinguir mayusculas; la nota es privada si ese campo vale true. Por defecto "private".
  privateField: string;
  // Hash + salt de la contrasena (nunca se guarda en claro). null = sin contrasena.
  passwordHash: string | null;
  passwordSalt: string | null;
  // Re-bloqueo automatico tras N minutos de haber desbloqueado.
  autoRelock: boolean;
  autoRelockMinutes: number;
  // Mostrar un pequeno indicador 🔒/🔓 en la barra de estado.
  showStatus: boolean;
  // Rutas que el plugin anadio a userIgnoreFilters en la ultima aplicacion.
  // Se persiste para poder revertirlas aunque Obsidian se cierre/crashee bloqueado.
  managedFilters: string[];
}

const DEFAULT_SETTINGS: PSMSettings = {
  privateField: "private",
  passwordHash: null,
  passwordSalt: null,
  autoRelock: false,
  autoRelockMinutes: 15,
  showStatus: true,
  managedFilters: [],
};

const STYLE_EL_ID = "private-safe-mode-hide-style";
const IGNORE_FILTERS_KEY = "userIgnoreFilters";
// Caracter de censura. Se repite uno por cada caracter (no espacio) del texto del enlace,
// para que la longitud de la censura sea proporcional al texto que oculta.
const CENSOR_CHAR = "■";

// Efecto de CodeMirror para forzar el recalculo de la censura del editor al bloquear/desbloquear
// (un cambio de estado externo que el editor no detecta por si solo).
const psmCensorRefresh = StateEffect.define<null>();

export default class PrivateSafeModePlugin extends Plugin {
  settings: PSMSettings;

  /** Rutas de las notas con `private: true`. */
  private privatePaths: Set<string> = new Set();
  /** Basenames (sin extension, en minuscula) de las notas privadas, para casar por nombre. */
  private privateNames: Set<string> = new Set();
  /** Rutas privadas sin extension (en minuscula), para casar enlaces por ruta. */
  private privatePathsNoExt: Set<string> = new Set();
  /** Estado del modo seguro. SIEMPRE arranca bloqueado (false). */
  private unlocked = false;
  /** <style> inyectado para ocultar del explorador. */
  private styleEl: HTMLStyleElement | null = null;
  /** Indicador de barra de estado. */
  private statusEl: HTMLElement | null = null;
  /** Timer del re-bloqueo automatico. */
  private relockTimer: number | null = null;
  /** Observer que filtra las entradas privadas en los paneles de backlinks/enlaces/menciones. */
  private linkObserver: MutationObserver | null = null;
  /** Handle del debounce del observer (paneles de enlaces). */
  private linkScanHandle: number | null = null;
  /** Handle del debounce del marcado de embeds del editor (Live Preview). */
  private embedScanHandle: number | null = null;

  async onload() {
    await this.loadSettings();

    this.rebuildPrivateSet();

    // Mantener actualizada la lista de notas privadas.
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => this.refreshPrivateSet())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.refreshPrivateSet())
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.refreshPrivateSet())
    );
    this.registerEvent(
      this.app.vault.on("delete", (f: TAbstractFile) => {
        this.privatePaths.delete(f.path);
        this.applyHiding();
      })
    );

    // Re-aplicar el ocultado del explorador y de los paneles cuando se redibuja la interfaz.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.applyExplorerHiding();
        if (!this.unlocked) this.filterLinkPanes();
      })
    );

    // Bloquear la apertura de notas privadas mientras esta bloqueado.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.guardOpen(file))
    );

    // Marcar los enlaces y embeds a notas privadas segun se renderiza el Markdown (vista
    // lectura/preview), para poder censurarlos con una cadena de cuadrados proporcional. El marcado
    // es inofensivo si esta desbloqueado: solo se ve censurado cuando applyExplorerHiding inyecta la
    // regla (es decir, mientras esta bloqueado).
    this.registerMarkdownPostProcessor((el) => this.markCensorable(el));

    // Censura en el editor (Live Preview y Source mode) via una extension de CodeMirror 6. El
    // post-procesador de arriba solo cubre la vista lectura; en el editor los enlaces son
    // decoraciones de CM6, no <a> del DOM, asi que hace falta este otro mecanismo.
    // Prec.highest: en Live Preview Obsidian tambien decora los enlaces/embeds; con prioridad
    // alta nuestra decoracion de censura prevalece sobre la suya en el mismo rango.
    this.registerEditorExtension(Prec.highest(buildCensorEditorExtension(this)));

    // Bloquear la vista previa al pasar el raton (hover preview) de enlaces/embeds
    // que apunten a notas privadas. En captura para adelantarnos al core "page preview".
    this.registerDomEvent(document, "mouseover", this.guardHover, { capture: true });

    // Comando para alternar el modo seguro (el usuario le asigna un atajo).
    this.addCommand({
      id: "toggle",
      name: "Alternar modo seguro (mostrar/ocultar notas privadas)",
      callback: () => this.toggleSafeMode(),
    });

    this.addCommand({
      id: "lock-now",
      name: "Bloquear ahora (ocultar notas privadas)",
      callback: () => this.lock(),
    });

    this.addSettingTab(new PSMSettingTab(this.app, this));

    if (this.settings.showStatus) this.ensureStatusEl();

    // Estado inicial: bloqueado -> ocultar todo.
    this.unlocked = false;
    this.applyHiding();

    // Al arrancar, el grafo puede restaurarse a la vez que aplicamos el estado inicial; forzamos un
    // recomputo cuando la interfaz esta lista para que los nodos privados no aparezcan de salida.
    this.app.workspace.onLayoutReady(() => this.refreshGraphViews());

    console.log("[private-safe-mode] cargado; notas privadas:", this.privatePaths.size);
  }

  onunload() {
    // Al descargar, restaurar la lista de excluidos (quitar lo nuestro) y el CSS.
    this.unlocked = true;
    this.applyIgnoreFilters();
    this.removeStyle();
    this.clearRelockTimer();
    this.disconnectLinkObserver();
    this.unhideLinkPanes();
  }

  // --------------------------------------------------------------------------
  // Deteccion de notas privadas
  // --------------------------------------------------------------------------

  private isPrivate(file: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return false;
    // El nombre del campo es configurable (ajustes) y se compara SIN distinguir
    // mayusculas/minusculas: la convencion del vault es `Private` (mayuscula) y Obsidian conserva
    // el case de la clave tal cual esta en el archivo, asi que un match literal no serviria. Si el
    // ajuste esta vacio, se usa "private" por defecto. La nota es privada si ese campo vale true
    // (booleano del toggle de propiedades) o la cadena "true".
    const field = (this.settings.privateField || "private").trim().toLowerCase();
    if (!field) return false;
    for (const key of Object.keys(fm)) {
      if (key.toLowerCase() === field) {
        const v = (fm as Record<string, unknown>)[key];
        return v === true || v === "true";
      }
    }
    return false;
  }

  /** Reconstruye desde cero el conjunto de rutas privadas (y los nombres derivados). */
  rebuildPrivateSet() {
    const next = new Set<string>();
    const names = new Set<string>();
    const pathsNoExt = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isPrivate(file)) {
        next.add(file.path);
        names.add(file.basename.toLowerCase());
        pathsNoExt.add(this.stripMdExt(file.path).toLowerCase());
      }
    }
    this.privatePaths = next;
    this.privateNames = names;
    this.privatePathsNoExt = pathsNoExt;
  }

  private stripMdExt(path: string): string {
    return path.replace(/\.md$/i, "");
  }

  /** Reconstruye y, si cambio, re-aplica el ocultado. */
  private refreshPrivateSet() {
    const before = this.serializeSet(this.privatePaths);
    this.rebuildPrivateSet();
    if (this.serializeSet(this.privatePaths) !== before) {
      this.applyHiding();
    }
  }

  private serializeSet(s: Set<string>): string {
    return Array.from(s).sort().join("\n");
  }

  // --------------------------------------------------------------------------
  // Aplicar / revertir el ocultado
  // --------------------------------------------------------------------------

  /** Aplica el estado actual (bloqueado oculta, desbloqueado muestra). */
  applyHiding() {
    this.applyIgnoreFilters();
    this.applyExplorerHiding();
    this.applyLinkPanes();
    this.closePrivateLeaves();
    this.refreshOmnisearch();
    this.refreshEditorCensor();
    this.updateStatus();
  }

  /**
   * Anade/quita las rutas privadas de la lista "Archivos excluidos" de Obsidian
   * (userIgnoreFilters), preservando las entradas propias del usuario.
   * Cubre busqueda nativa, grafo, switcher y sugerencias de enlace.
   */
  private applyIgnoreFilters() {
    const vault: any = this.app.vault as any;
    if (typeof vault.getConfig !== "function" || typeof vault.setConfig !== "function") {
      console.warn("[private-safe-mode] getConfig/setConfig no disponibles en esta version de Obsidian");
      return;
    }

    const current: string[] = vault.getConfig(IGNORE_FILTERS_KEY) || [];
    // Quitar lo que nosotros anadimos antes -> queda la lista propia del usuario.
    // Tratamos como "gestionado por nosotros" DOS conjuntos:
    //   1) managedFilters: el registro persistido de lo que anadimos la ultima vez.
    //   2) las rutas privadas ACTUALES (privatePaths).
    // El (2) es la red de seguridad: aunque managedFilters se pierda o desincronice
    // (version antigua del plugin, data.json viejo, cierre sin onunload, crash), las
    // exclusiones de notas privadas se limpian igualmente y no quedan huerfanas para
    // siempre (que es justo lo que rompia las Bases nativas y la busqueda).
    // Compromiso asumido: si el usuario habia excluido A MANO una nota que ahora es
    // privada, esa exclusion manual pasa a gestionarla el modo seguro (reaparecera al
    // desbloquear). Se considera preferible a dejar exclusiones huerfanas permanentes.
    const prevManaged = this.settings.managedFilters || [];
    const managed = new Set<string>([...prevManaged, ...this.privatePaths]);
    const base = current.filter((f) => !managed.has(f));

    let next: string[];
    let newManaged: string[];
    if (this.unlocked) {
      next = base;
      newManaged = [];
    } else {
      const toHide = Array.from(this.privatePaths).filter((p) => !base.includes(p));
      next = base.concat(toHide);
      newManaged = toHide;
    }

    // Persistir el registro de lo gestionado (para revertir aunque se cierre bloqueado).
    if (!this.sameList(prevManaged, newManaged)) {
      this.settings.managedFilters = newManaged;
      void this.saveSettings();
    }

    // Evitar escrituras innecesarias en la config de Obsidian.
    if (this.sameList(current, next)) return;
    vault.setConfig(IGNORE_FILTERS_KEY, next);
    // Obsidian refresca busqueda/switcher al cambiar userIgnoreFilters, pero el GRAFO no se entera
    // solo: respeta "Archivos excluidos" pero solo recomputa sus nodos ante ciertos eventos (por eso
    // al pulsar un nodo privado el grafo "se resetea" y el nodo desaparece). Lo forzamos a recomputar
    // aqui, justo cuando la lista de excluidos cambia (bloquear/desbloquear/cambio del set privado).
    // Como solo entramos aqui cuando la lista REALMENTE cambia, no se dispara en cada layout-change.
    this.refreshGraphViews();
  }

  private sameList(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((x) => sb.has(x));
  }

  /**
   * Fuerza a las vistas de grafo (global y local) a recomputar sus nodos, para que apliquen la lista
   * "Archivos excluidos" (userIgnoreFilters) que acabamos de cambiar y los nodos privados aparezcan/
   * desaparezcan al instante, sin tener que interactuar con el grafo.
   *
   * Best-effort: usa la API interna no documentada del motor del grafo (`dataEngine`/`engine`). Solo
   * RE-RENDERIZA (no persiste ni modifica notas); si la API cambia entre versiones, degrada a no-op
   * (el grafo seguiria recomputando al interactuar, como antes).
   */
  private refreshGraphViews() {
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view: any = leaf.view;
        const engine = view?.dataEngine ?? view?.engine;
        try {
          if (engine && typeof engine.render === "function") engine.render();
        } catch (e) {
          console.warn("[private-safe-mode] no se pudo refrescar el grafo:", e);
        }
      }
    }
  }

  /**
   * Oculta (o muestra) via CSS las notas privadas en el explorador y los enlaces internos
   * (`[[...]]`) que apuntan a ellas dentro del texto de otras notas (vista lectura / preview).
   */
  applyExplorerHiding() {
    if (this.unlocked || this.privatePaths.size === 0) {
      this.removeStyle();
      return;
    }

    const blocks: string[] = [];

    // 1) Explorador de archivos.
    const explorerSel = Array.from(this.privatePaths)
      .map((p) => `.nav-file:has(> .nav-file-title[data-path="${this.cssAttr(p)}"])`)
      .join(",\n");
    if (explorerSel) blocks.push(`${explorerSel} { display: none !important; }`);

    // 2) Enlaces internos en el texto y 3) embeds ![[...]]: ambos se CENSURAN (no se ocultan).
    //    CSS no puede contar caracteres, asi que QUE censurar y CON CUANTOS cuadrados lo decide
    //    markCensorable() en JS: marca el elemento con una clase (`psm-censored-link` /
    //    `psm-censored-embed`) y guarda en `--psm-censor` la cadena de censura (un `■` por caracter
    //    no-espacio, longitud proporcional). Aqui solo van las reglas que la pintan, y solo mientras
    //    esta bloqueado (este <style> se elimina al desbloquear). El elemento queda inerte
    //    (pointer-events); guardOpen/guardHover cubren igualmente el click/hover.
    //
    //    Declaracion compartida del ::after que pinta los cuadrados (grandes y solidos; line-height:0
    //    + vertical-align evita que descuadre el interlineado).
    const censorAfter =
      `  content: var(--psm-censor, "${CENSOR_CHAR}${CENSOR_CHAR}${CENSOR_CHAR}${CENSOR_CHAR}");\n` +
      `  color: var(--text-normal);\n` +
      `  font-size: calc(var(--font-text-size, 1rem) * 1.6);\n` +
      `  line-height: 0;\n` +
      `  vertical-align: -0.12em;\n` +
      `  letter-spacing: 0.04em;\n`;

    // 2) Enlaces: font-size:0 colapsa el texto original (que podria revelar el nombre/alias).
    blocks.push(
      `a.internal-link.psm-censored-link {\n` +
        `  color: transparent !important;\n` +
        `  font-size: 0 !important;\n` +
        `  text-decoration: none !important;\n` +
        `  cursor: default !important;\n` +
        `  pointer-events: none !important;\n` +
        `}\n` +
        `a.internal-link.psm-censored-link::after {\n${censorAfter}}`
    );

    // 3) Embeds: se oculta el contenido embebido (los hijos) y se pinta la censura con el ::after.
    //    La censura es proporcional al NOMBRE de la nota embebida, no a su contenido.
    blocks.push(
      `.internal-embed.psm-censored-embed {\n` +
        `  pointer-events: none !important;\n` +
        `  cursor: default !important;\n` +
        `}\n` +
        `.internal-embed.psm-censored-embed > * { display: none !important; }\n` +
        `.internal-embed.psm-censored-embed::after {\n${censorAfter}}`
    );

    // Marcar lo ya renderizado (notas abiertas al cargar/bloquear). Lo que se renderice
    // despues lo marca el post-procesador registrado en onload().
    //
    // IMPORTANTE: se acota a contenedores de SOLO LECTURA (`.markdown-preview-view`). NO se
    // barre `workspace.containerEl` entero porque eso incluiria el DOM del editor (Live
    // Preview), donde los enlaces/embeds los gestiona la extension de CodeMirror; meter ahi
    // clases CSS pisaria a CM y causaria flicker/doble render. `.markdown-preview-view` no
    // existe en Live Preview, asi que este barrido nunca toca el editor.
    this.app.workspace.containerEl
      .querySelectorAll<HTMLElement>(".markdown-preview-view")
      .forEach((view) => this.markCensorable(view));

    // Embeds renderizados dentro del editor de Live Preview (la decoracion de CodeMirror no
    // llega a ellos por ser widget de bloque; aqui se censuran por DOM/CSS).
    this.markEditorEmbeds();

    this.ensureStyle().textContent = blocks.join("\n\n");
  }

  /** Escapa un valor para usarlo dentro de comillas dobles en un selector de atributo CSS. */
  private cssAttr(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /** True si el modo seguro esta DESBLOQUEADO (notas privadas visibles). */
  isSafeModeUnlocked(): boolean {
    return this.unlocked;
  }

  /**
   * True si un linktext (lo de dentro de `[[...]]`/`![[...]]`, posiblemente con `|alias`,
   * `#heading` o `^block`) apunta a una nota privada. Casa por basename y por ruta sin extension,
   * igual que el resto del plugin.
   */
  isPrivateLinktext(linktext: string): boolean {
    const path = linktext.split(/[#^|]/)[0].trim();
    if (!path) return false;
    const key = path.toLowerCase();
    const keyNoDir = key.split("/").pop() || key;
    return this.privatePathsNoExt.has(key) || this.privateNames.has(keyNoDir);
  }

  /**
   * Reaplica la censura del editor en todos los editores abiertos (al bloquear/desbloquear).
   *
   * INVARIANTE DE SEGURIDAD: este plugin SOLO despacha `effects` a CodeMirror, NUNCA `changes`.
   * La censura es exclusivamente de presentacion; esta PROHIBIDO anadir `changes` a cualquier
   * transaccion. El contenido real de las notas (.md) no debe cambiar jamas.
   */
  private refreshEditorCensor() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = (leaf.view as any)?.editor?.cm as EditorView | undefined;
      try {
        // Solo `effects` (sin `changes`): no toca el documento. Ver invariante de arriba.
        cm?.dispatch({ effects: psmCensorRefresh.of(null) });
      } catch {
        // Despachar durante un ciclo de update de CM lanzaria; lo ignoramos a proposito:
        // el editor recalcula la censura por su cuenta en su siguiente update (scroll, edicion,
        // seleccion), asi que un refresco perdido se autocorrige y nunca rompe nada.
      }
    });
  }

  /**
   * Construye la cadena de censura para un texto: un `■` por cada caracter no-espacio,
   * conservando los espacios para no fundir las palabras. La longitud queda proporcional
   * al texto original. Nunca devuelve vacio (minimo un cuadrado).
   */
  censorString(text: string): string {
    const out = Array.from(text)
      .map((ch) => (/\s/.test(ch) ? " " : CENSOR_CHAR))
      .join("");
    return out.trim().length ? out : CENSOR_CHAR;
  }

  /**
   * Marca dentro de `root` los enlaces internos (`a.internal-link`) y los embeds
   * (`.internal-embed`) que apuntan a una nota privada, para poder censurarlos: les pone la clase
   * correspondiente (`psm-censored-link` / `psm-censored-embed`) y la variable `--psm-censor` con
   * la cadena de cuadrados proporcional. El que se vean censurados o no lo decide la regla CSS que
   * solo se inyecta mientras esta bloqueado (ver applyExplorerHiding). El match es por destino
   * (`data-href` en enlaces, `src` en embeds), igual que el resto del plugin, asi que censura
   * tambien los enlaces con alias `[[nota|texto]]`.
   *
   * Diferencia clave entre ambos: en el enlace la longitud es proporcional a su TEXTO visible; en
   * el embed, al NOMBRE de la nota embebida (su `src`), no a su contenido (que seria enorme).
   */
  private markCensorable(root: ParentNode) {
    this.markCensorableLinks(root);
    this.markCensorableEmbeds(root);
  }

  /**
   * Enlaces internos: censura proporcional al texto visible. Si NO casa, se quita la clase: la
   * regla CSS es generica (`.psm-censored-link`), asi que una clase "pegada" de un destino que
   * ya no es privado seguiria censurando el enlace por error. Limpiar en cada barrido lo evita.
   */
  private markCensorableLinks(root: ParentNode) {
    const targets = new Set<string>([...this.privateNames, ...this.privatePathsNoExt]);
    root.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      const href = (a.getAttribute("data-href") || "")
        .trim()
        .split(/[#^|]/)[0]
        .trim()
        .toLowerCase();
      if (href && targets.has(href)) {
        a.classList.add("psm-censored-link");
        // El valor de --psm-censor es un <string> CSS: va entre comillas. Solo contiene
        // cuadrados y espacios, asi que no necesita escapado adicional.
        a.style.setProperty("--psm-censor", `"${this.censorString((a.textContent || "").trim())}"`);
      } else {
        a.classList.remove("psm-censored-link");
      }
    });
  }

  /**
   * Embeds `.internal-embed`: censura proporcional al nombre de la nota embebida. Misma limpieza
   * "si no casa -> remove" que los enlaces. Se usa tanto en vista lectura como dentro del editor
   * de Live Preview (donde Obsidian renderiza el embed como widget de bloque y la decoracion de
   * CodeMirror no llega; aqui lo censuramos por DOM/CSS, igual que en lectura).
   */
  private markCensorableEmbeds(root: ParentNode) {
    const targets = new Set<string>([...this.privateNames, ...this.privatePathsNoExt]);
    root.querySelectorAll<HTMLElement>(".internal-embed").forEach((em) => {
      const linkpath = (em.getAttribute("src") || "").trim().split(/[#^|]/)[0].trim();
      const key = linkpath.toLowerCase();
      const keyNoDir = key.split("/").pop() || key;
      if (linkpath && (targets.has(key) || targets.has(keyNoDir))) {
        em.classList.add("psm-censored-embed");
        const name = linkpath.split("/").pop() || linkpath;
        em.style.setProperty("--psm-censor", `"${this.censorString(name)}"`);
      } else {
        em.classList.remove("psm-censored-embed");
      }
    });
  }

  /** Marca los embeds renderizados dentro de los editores (Live Preview) como censurables. */
  private markEditorEmbeds() {
    this.app.workspace.containerEl
      .querySelectorAll<HTMLElement>(".markdown-source-view")
      .forEach((view) => this.markCensorableEmbeds(view));
  }

  // --------------------------------------------------------------------------
  // Paneles de backlinks / enlaces salientes / menciones
  // --------------------------------------------------------------------------
  //
  // No hay forma estable via CSS de seleccionar una entrada por su ruta, asi que
  // recorremos el DOM renderizado de esos paneles y ocultamos las entradas cuyo
  // titulo de archivo coincide con una nota privada (por basename). Un
  // MutationObserver vuelve a aplicarlo cada vez que el panel se redibuja.
  //
  // Limitacion: el match es por nombre de archivo, asi que una nota NO privada que
  // comparta basename con una privada tambien se ocultaria en estos paneles. Se
  // prefiere ese exceso de ocultado antes que filtrar una nota privada.

  /** Activa o desactiva el filtrado de los paneles segun el estado actual. */
  private applyLinkPanes() {
    if (this.unlocked || this.privateNames.size === 0) {
      this.disconnectLinkObserver();
      this.unhideLinkPanes();
      return;
    }
    this.connectLinkObserver();
    this.filterLinkPanes();
  }

  private connectLinkObserver() {
    if (this.linkObserver) return;
    this.linkObserver = new MutationObserver((mutations) => {
      // Solo escanear si la mutacion afecta a un panel de enlaces; asi no recalculamos
      // con cada cambio del DOM (p. ej. al teclear en el editor).
      if (mutations.some((m) => this.mutationAffectsLinkPane(m))) {
        this.scheduleLinkScan();
      }
      // Los embeds en Live Preview se renderizan de forma diferida (al hacer scroll); cuando
      // aparece un `.internal-embed` nuevo, re-marcamos los embeds del editor para censurarlos.
      if (mutations.some((m) => this.mutationAddsEmbed(m))) {
        this.scheduleEmbedScan();
      }
    });
    this.linkObserver.observe(this.app.workspace.containerEl, {
      childList: true,
      subtree: true,
    });
  }

  private mutationAddsEmbed(m: MutationRecord): boolean {
    for (const node of Array.from(m.addedNodes)) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches?.(".internal-embed") || node.querySelector?.(".internal-embed")) {
        return true;
      }
    }
    return false;
  }

  private mutationAffectsLinkPane(m: MutationRecord): boolean {
    const PANES = ".backlink-pane, .outgoing-link-pane";
    const target = m.target as HTMLElement | null;
    if (target?.closest?.(PANES)) return true;
    for (const node of Array.from(m.addedNodes)) {
      if (!(node instanceof HTMLElement)) continue;
      if (
        node.matches?.(`${PANES}, .search-result-file-title`) ||
        node.querySelector?.(".search-result-file-title")
      ) {
        return true;
      }
    }
    return false;
  }

  private disconnectLinkObserver() {
    if (this.linkObserver) {
      this.linkObserver.disconnect();
      this.linkObserver = null;
    }
    if (this.linkScanHandle !== null) {
      window.clearTimeout(this.linkScanHandle);
      this.linkScanHandle = null;
    }
    if (this.embedScanHandle !== null) {
      window.clearTimeout(this.embedScanHandle);
      this.embedScanHandle = null;
    }
  }

  /** Debounce del recorrido para no recalcular en cada mutacion. */
  private scheduleLinkScan() {
    if (this.linkScanHandle !== null) return;
    this.linkScanHandle = window.setTimeout(() => {
      this.linkScanHandle = null;
      this.filterLinkPanes();
    }, 50);
  }

  /** Debounce del marcado de embeds del editor (Live Preview). */
  private scheduleEmbedScan() {
    if (this.embedScanHandle !== null) return;
    this.embedScanHandle = window.setTimeout(() => {
      this.embedScanHandle = null;
      if (!this.unlocked) this.markEditorEmbeds();
    }, 50);
  }

  /** Recorre los paneles y oculta las entradas de archivo que son notas privadas. */
  filterLinkPanes() {
    if (this.unlocked) return;
    const panes = document.querySelectorAll(".backlink-pane, .outgoing-link-pane");
    panes.forEach((pane) => {
      pane.querySelectorAll<HTMLElement>(".search-result-file-title").forEach((titleEl) => {
        const inner = titleEl.querySelector<HTMLElement>(".tree-item-inner") ?? titleEl;
        const name = (inner.textContent ?? "").trim().toLowerCase();
        const group = (titleEl.closest(".tree-item") as HTMLElement | null) ?? titleEl.parentElement;
        if (!group) return;
        const hide = name.length > 0 && this.privateNames.has(name);
        group.classList.toggle("psm-link-hidden", hide);
      });
    });
  }

  /** Quita el ocultado de todas las entradas (al desbloquear o descargar). */
  private unhideLinkPanes() {
    document
      .querySelectorAll(".psm-link-hidden")
      .forEach((el) => el.classList.remove("psm-link-hidden"));
  }

  private ensureStyle(): HTMLStyleElement {
    if (this.styleEl && this.styleEl.isConnected) return this.styleEl;
    const el = document.createElement("style");
    el.id = STYLE_EL_ID;
    document.head.appendChild(el);
    this.styleEl = el;
    return el;
  }

  private removeStyle() {
    if (this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
    const stray = document.getElementById(STYLE_EL_ID);
    if (stray) stray.remove();
  }

  /**
   * Pide a Omnisearch que reindexe (si su API lo permite). Omnisearch debe tener
   * activado "Respect Obsidian's Excluded Files". El metodo exacto de la API no
   * esta garantizado entre versiones, por eso va defensivo.
   */
  private refreshOmnisearch() {
    try {
      const om: any = (this.app as any).plugins?.plugins?.["omnisearch"];
      const api = om?.api;
      if (api && typeof api.refreshIndex === "function") {
        api.refreshIndex();
      }
    } catch (e) {
      console.warn("[private-safe-mode] no se pudo refrescar Omnisearch:", e);
    }
  }

  // --------------------------------------------------------------------------
  // Bloqueo de apertura
  // --------------------------------------------------------------------------

  private guardOpen(file: TFile | null) {
    if (this.unlocked || !file) return;
    if (!this.privatePaths.has(file.path)) return;

    // Cerrar la hoja que acaba de abrir la nota privada.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const leaf = view?.leaf ?? (this.app.workspace as any).activeLeaf;
    if (leaf) {
      try {
        leaf.detach();
      } catch {
        /* ignore */
      }
    }
    new Notice("Nota privada: activa el modo seguro para abrirla.");
  }

  /** Cierra cualquier hoja (pestana/panel) que tenga abierta una nota privada. */
  private closePrivateLeaves() {
    if (this.unlocked || this.privatePaths.size === 0) return;
    const toDetach: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const file = (leaf.view as any)?.file as TFile | undefined;
      if (file && this.privatePaths.has(file.path)) toDetach.push(leaf);
    });
    for (const leaf of toDetach) {
      try {
        leaf.detach();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Intercepta el hover sobre enlaces/embeds a notas privadas para que el plugin
   * core "Page preview" no muestre su contenido. Best-effort: en captura sobre el
   * documento; en Live Preview el destino del enlace no siempre es legible desde el DOM.
   */
  private guardHover = (evt: MouseEvent) => {
    if (this.unlocked || this.privatePaths.size === 0) return;
    const target = evt.target as HTMLElement | null;
    if (!target?.closest) return;
    const el = target.closest(
      "a.internal-link, .internal-embed, .cm-hmd-internal-link, .cm-link"
    ) as HTMLElement | null;
    if (!el) return;
    const linktext = this.linktextFromEl(el);
    if (!linktext) return;
    const source = this.app.workspace.getActiveFile()?.path ?? "";
    const dest = this.app.metadataCache.getFirstLinkpathDest(linktext, source);
    if (dest && this.privatePaths.has(dest.path)) {
      evt.stopImmediatePropagation();
      evt.preventDefault();
    }
  };

  /** Extrae el linkpath (sin subpath/alias) de un elemento de enlace o embed. */
  private linktextFromEl(el: HTMLElement): string | null {
    const raw =
      el.getAttribute("data-href") ||
      el.getAttribute("src") ||
      el.getAttribute("href") ||
      el.textContent ||
      "";
    const base = raw.trim().split(/[#^|]/)[0].trim();
    return base || null;
  }

  // --------------------------------------------------------------------------
  // Bloqueo / desbloqueo
  // --------------------------------------------------------------------------

  toggleSafeMode() {
    if (this.unlocked) {
      this.lock();
    } else {
      this.promptUnlock();
    }
  }

  private promptUnlock() {
    if (!this.settings.passwordHash || !this.settings.passwordSalt) {
      new Notice("No hay contrasena configurada. Ve a los ajustes de Private Safe Mode.");
      return;
    }
    new PasswordModal(this.app, async (password) => {
      const ok = await this.verifyPassword(password);
      if (ok) {
        this.unlock();
      } else {
        new Notice("Contrasena incorrecta.");
      }
    }).open();
  }

  private unlock() {
    this.unlocked = true;
    this.applyHiding();
    new Notice("Modo seguro ACTIVADO: notas privadas visibles.");
    this.scheduleRelock();
  }

  lock() {
    this.unlocked = false;
    this.applyHiding();
    this.clearRelockTimer();
    if (this.settings.showStatus) new Notice("Notas privadas ocultas.");
  }

  private scheduleRelock() {
    this.clearRelockTimer();
    if (!this.settings.autoRelock) return;
    const ms = Math.max(1, this.settings.autoRelockMinutes) * 60_000;
    this.relockTimer = window.setTimeout(() => this.lock(), ms);
    this.registerInterval(this.relockTimer); // limpieza al descargar
  }

  private clearRelockTimer() {
    if (this.relockTimer !== null) {
      window.clearTimeout(this.relockTimer);
      this.relockTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Contrasena (SHA-256 con salt; nunca se guarda en claro)
  // --------------------------------------------------------------------------

  async setPassword(password: string) {
    const salt = this.randomHex(16);
    const hash = await this.hash(password, salt);
    this.settings.passwordSalt = salt;
    this.settings.passwordHash = hash;
    await this.saveSettings();
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.settings.passwordHash || !this.settings.passwordSalt) return false;
    const hash = await this.hash(password, this.settings.passwordSalt);
    return this.timingSafeEqual(hash, this.settings.passwordHash);
  }

  private async hash(password: string, saltHex: string): Promise<string> {
    const enc = new TextEncoder();
    const data = enc.encode(saltHex + ":" + password);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return this.bufToHex(buf);
  }

  private randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // --------------------------------------------------------------------------
  // Barra de estado
  // --------------------------------------------------------------------------

  ensureStatusEl() {
    if (this.statusEl) return;
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("psm-status");
    // Clic en el indicador = alternar el modo (mostrar/ocultar notas privadas).
    this.registerDomEvent(this.statusEl, "click", () => this.toggleSafeMode());
    this.updateStatus();
  }

  removeStatusEl() {
    if (this.statusEl) {
      this.statusEl.remove();
      this.statusEl = null;
    }
  }

  private updateStatus() {
    if (!this.statusEl) return;
    const n = this.privatePaths.size;
    this.statusEl.setText(this.unlocked ? `🔓 privadas (${n})` : `🔒 privadas (${n})`);
    this.statusEl.setAttr(
      "aria-label",
      this.unlocked ? "Modo seguro activo: notas privadas visibles" : "Notas privadas ocultas"
    );
  }

  // --------------------------------------------------------------------------
  // Ajustes
  // --------------------------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  countPrivate(): number {
    return this.privatePaths.size;
  }
}

// ----------------------------------------------------------------------------
// Censura en el editor (CodeMirror 6): Live Preview y Source mode
// ----------------------------------------------------------------------------
//
// En el editor los enlaces NO son <a class="internal-link"> del DOM (eso es la vista lectura),
// sino texto gestionado por CodeMirror. Para censurarlos hay que decorar el editor: recorremos el
// texto visible buscando `[[...]]` / `![[...]]`, y los que apuntan a una nota privada los
// reemplazamos por un widget con la barra de cuadrados. Para poder seguir editandolos, NO se
// censura el enlace sobre el que esta el cursor/seleccion (se muestra el texto crudo), igual que
// Live Preview revela la sintaxis al entrar en ella.
//
// Limitacion conocida: en Live Preview, Obsidian ya decora los enlaces por su cuenta; nuestra
// decoracion de reemplazo se solapa con la suya sobre el mismo rango. En la practica nuestra
// censura prevalece, pero es un punto fragil que conviene probar entre versiones de Obsidian.

/** Widget que pinta la barra de censura (cuadrados) en el editor. */
class CensorEditorWidget extends WidgetType {
  constructor(private readonly censor: string) {
    super();
  }
  eq(other: CensorEditorWidget): boolean {
    return other.censor === this.censor;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "psm-censored-cm";
    span.textContent = this.censor;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// Coincide con `[[...]]` y `![[...]]` (captura el `!` opcional y el interior sin corchetes).
// Se crea uno NUEVO en cada build() (no un global mutable compartido) para no arrastrar
// `lastIndex` entre llamadas / editores.
const wikilinkRe = () => /(!?)\[\[([^\[\]\r\n]+?)\]\]/g;

/**
 * Construye la extension de editor que censura los enlaces/embeds a notas privadas.
 *
 * INVARIANTE DE SEGURIDAD: solo produce DECORACIONES (vista). Nunca despacha transacciones ni
 * `changes`; un widget de reemplazo es atomico y CM no lo reincorpora al documento. El texto
 * real de la nota NO cambia jamas por censurarla.
 */
function buildCensorEditorExtension(plugin: PrivateSafeModePlugin) {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    // Desbloqueado: sin censura.
    if (plugin.isSafeModeUnlocked()) return builder.finish();

    // En Live Preview, Obsidian renderiza `![[...]]` como widget de bloque y esta decoracion
    // inline no llega; esos embeds los censura el DOM/CSS (markEditorEmbeds). Aqui, en LP, NO
    // censuramos embeds (para no solapar mecanismos); en Source mode si (no hay render). Los
    // enlaces se censuran en ambos modos. `field(..., false)` no lanza si el campo no existe.
    const isLivePreview = view.state.field(editorLivePreviewField, false) === true;

    const sel = view.state.selection;
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      const re = wikilinkRe();
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const start = from + m.index;
        const end = start + m[0].length;
        const isEmbed = m[1] === "!";
        if (isEmbed && isLivePreview) continue;
        const inner = m[2];
        const [targetRaw, alias] = inner.split("|");
        if (!plugin.isPrivateLinktext(targetRaw)) continue;

        // No censurar el enlace que se esta editando (cursor/seleccion dentro): mostrar crudo.
        const touched = sel.ranges.some((r) => r.from <= end && r.to >= start);
        if (touched) continue;

        // Longitud de la censura: en el enlace, su texto visible (alias o nombre); en el embed,
        // el nombre de la nota embebida.
        const display = isEmbed
          ? targetRaw.split(/[#^]/)[0].split("/").pop() || targetRaw
          : (alias ?? targetRaw.split(/[#^]/)[0]);
        const censor = plugin.censorString(display.trim());
        builder.add(start, end, Decoration.replace({ widget: new CensorEditorWidget(censor) }));
      }
    }
    return builder.finish();
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        const forced = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(psmCensorRefresh))
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || forced) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// ----------------------------------------------------------------------------
// Modal de contrasena
// ----------------------------------------------------------------------------

class PasswordModal extends Modal {
  private onSubmit: (password: string) => void;

  constructor(app: App, onSubmit: (password: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Modo seguro" });
    contentEl.createEl("p", { text: "Introduce la contrasena para mostrar las notas privadas." });

    const input = contentEl.createEl("input", { type: "password" });
    input.style.width = "100%";
    input.focus();

    const submit = () => {
      const value = input.value;
      this.close();
      this.onSubmit(value);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    const buttons = contentEl.createDiv();
    buttons.style.marginTop = "12px";
    buttons.style.textAlign = "right";
    const ok = buttons.createEl("button", { text: "Desbloquear" });
    ok.addClass("mod-cta");
    ok.addEventListener("click", submit);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ----------------------------------------------------------------------------
// Pestana de ajustes
// ----------------------------------------------------------------------------

class PSMSettingTab extends PluginSettingTab {
  plugin: PrivateSafeModePlugin;

  constructor(app: App, plugin: PrivateSafeModePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Private Safe Mode" });

    const warn = containerEl.createEl("p", {
      text:
        "Aviso: esto es OCULTACION, no cifrado. Las notas privadas siguen siendo texto plano en disco y pueden leerse fuera de Obsidian o desactivando este plugin. Para Omnisearch, activa ademas 'Respect Obsidian's Excluded Files' en sus ajustes.",
    });
    warn.style.opacity = "0.8";
    warn.style.fontSize = "0.85em";

    const countEl = containerEl.createEl("p", {
      text: `Notas privadas detectadas: ${this.plugin.countPrivate()}`,
    });

    // Campo de frontmatter usado como criterio
    let fieldDebounce: number | null = null;
    new Setting(containerEl)
      .setName("Campo de frontmatter para notas privadas")
      .setDesc(
        "Nombre de la propiedad que marca una nota como privada (NSFW). Se compara SIN distinguir " +
          "mayusculas/minusculas; la nota es privada si ese campo vale true. Por defecto: private."
      )
      .addText((t) =>
        t
          .setPlaceholder("private")
          .setValue(this.plugin.settings.privateField)
          .onChange(async (v) => {
            this.plugin.settings.privateField = v;
            await this.plugin.saveSettings();
            // Debounce: recalcular el conjunto de notas privadas y re-aplicar el ocultado/censura
            // sin hacerlo en cada pulsacion (recorre todo el vault).
            if (fieldDebounce !== null) window.clearTimeout(fieldDebounce);
            fieldDebounce = window.setTimeout(() => {
              this.plugin.rebuildPrivateSet();
              this.plugin.applyHiding();
              countEl.setText(`Notas privadas detectadas: ${this.plugin.countPrivate()}`);
            }, 400);
          })
      );

    // Contrasena
    let pwd1 = "";
    let pwd2 = "";
    new Setting(containerEl)
      .setName("Contrasena nueva")
      .setDesc("Se guarda solo el hash (SHA-256 con salt), nunca la contrasena en claro.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("nueva contrasena").onChange((v) => (pwd1 = v));
      });
    new Setting(containerEl)
      .setName("Repetir contrasena")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("repite la contrasena").onChange((v) => (pwd2 = v));
      });
    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Guardar contrasena")
        .setCta()
        .onClick(async () => {
          if (!pwd1) {
            new Notice("Escribe una contrasena.");
            return;
          }
          if (pwd1 !== pwd2) {
            new Notice("Las contrasenas no coinciden.");
            return;
          }
          await this.plugin.setPassword(pwd1);
          new Notice("Contrasena guardada.");
        })
    );

    // Re-bloqueo automatico
    new Setting(containerEl)
      .setName("Re-bloqueo automatico")
      .setDesc("Volver a ocultar las notas privadas pasados unos minutos tras desbloquear.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoRelock).onChange(async (v) => {
          this.plugin.settings.autoRelock = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Minutos hasta el re-bloqueo")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.autoRelockMinutes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.autoRelockMinutes = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // Indicador de barra de estado
    new Setting(containerEl)
      .setName("Mostrar indicador en la barra de estado")
      .setDesc("Un pequeno candado que indica si el modo seguro esta activo. Click para alternar.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showStatus).onChange(async (v) => {
          this.plugin.settings.showStatus = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.ensureStatusEl();
          else this.plugin.removeStatusEl();
        })
      );
  }
}
