import {
  App,
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
  passwordHash: null,
  passwordSalt: null,
  autoRelock: false,
  autoRelockMinutes: 15,
  showStatus: true,
  managedFilters: [],
};

const STYLE_EL_ID = "private-safe-mode-hide-style";
const IGNORE_FILTERS_KEY = "userIgnoreFilters";

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
  /** Handle del debounce del observer. */
  private linkScanHandle: number | null = null;

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
    return fm?.private === true;
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
    // Quitar lo que nosotros anadimos antes (segun el registro persistido) -> queda
    // la lista propia del usuario. Si una sesion anterior se cerro bloqueada, esto
    // recupera y limpia las entradas huerfanas.
    const prevManaged = this.settings.managedFilters || [];
    const managed = new Set(prevManaged);
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
    // Obsidian refresca busqueda/grafo/switcher al cambiar userIgnoreFilters.
    // El explorador lo refrescamos nosotros con el CSS (applyExplorerHiding).
  }

  private sameList(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((x) => sb.has(x));
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

    // 2) Enlaces internos en el texto: <a class="internal-link" data-href="...">.
    //    El data-href puede ser el basename, la ruta sin extension, o llevar subpath (#, ^).
    const linkTargets = new Set<string>([...this.privateNames, ...this.privatePathsNoExt]);
    const linkSel: string[] = [];
    for (const name of linkTargets) {
      const v = this.cssAttr(name);
      linkSel.push(`a.internal-link[data-href="${v}" i]`);
      linkSel.push(`a.internal-link[data-href^="${v}#" i]`);
      linkSel.push(`a.internal-link[data-href^="${v}^" i]`);
    }
    if (linkSel.length) {
      blocks.push(`${linkSel.join(",\n")} { display: none !important; }`);
    }

    // 3) Embeds ![[nota privada]]: <span/div class="internal-embed" src="...">.
    //    Si no se ocultaran, el contenido de la nota privada se renderiza inline.
    const embedSel: string[] = [];
    for (const name of linkTargets) {
      const v = this.cssAttr(name);
      embedSel.push(`.internal-embed[src="${v}" i]`);
      embedSel.push(`.internal-embed[src^="${v}#" i]`);
      embedSel.push(`.internal-embed[src^="${v}^" i]`);
    }
    if (embedSel.length) {
      blocks.push(`${embedSel.join(",\n")} { display: none !important; }`);
    }

    this.ensureStyle().textContent = blocks.join("\n\n");
  }

  /** Escapa un valor para usarlo dentro de comillas dobles en un selector de atributo CSS. */
  private cssAttr(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    });
    this.linkObserver.observe(this.app.workspace.containerEl, {
      childList: true,
      subtree: true,
    });
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
  }

  /** Debounce del recorrido para no recalcular en cada mutacion. */
  private scheduleLinkScan() {
    if (this.linkScanHandle !== null) return;
    this.linkScanHandle = window.setTimeout(() => {
      this.linkScanHandle = null;
      this.filterLinkPanes();
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

    containerEl.createEl("p", {
      text: `Notas privadas detectadas: ${this.plugin.countPrivate()}`,
    });

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
