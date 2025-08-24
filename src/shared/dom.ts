export function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

export async function waitForElement(selector: string, timeout=15000): Promise<Element | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(200);
  }
  return null;
}

export function findByText<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] | null {
  text = text.trim().toLowerCase();
  const nodes = Array.from(document.getElementsByTagName(tag));
  return nodes.find(n => (n.textContent||"").trim().toLowerCase() === text) as any ?? null;
}

export function clickByTexts(texts: string[]): boolean {
  const buttons = Array.from(document.querySelectorAll("button, a, [role='button']")) as HTMLElement[];
  for (const t of texts) {
    const bt = buttons.find(b => (b.textContent||"").trim().toLowerCase().includes(t.toLowerCase()));
    if (bt) { (bt as HTMLElement).click(); return true; }
  }
  return false;
}

export function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  nativeSetter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function setCheckbox(el: HTMLInputElement, checked: boolean) {
  el.checked = checked;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
