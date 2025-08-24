import type { ProfileData, WorkExperience, EducationExperience, ProjectExperience } from "@shared/types";
import { loadData } from "@shared/storage";
import { canonicalProfile, FIELD_HINTS } from "@shared/mapping";
import { sleep, waitForElement, setInputValue, setCheckbox, clickByTexts } from "@shared/dom";
import { randomEmail, randomPhone, randomString } from "@shared/random";

declare global {
  interface Window { __WDAF_RUNNING?: boolean }
}

console.log('[WDAF] Content script loaded on:', location.href);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[WDAF] Received message:', msg);
  if (msg?.type === "START_AUTOFILL") {
    start().then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      console.error('[WDAF] Start error:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Indicates we will send a response asynchronously
  }
});

(async function autoStart() {
  const { autofillOnLoad } = await chrome.storage.local.get("autofillOnLoad");
  if (autofillOnLoad) {
    // Attempt auto start on recognized Workday pages
    const host = location.host.toLowerCase();
    if (host.includes("workday")) {
      start();
    }
  }
})();

async function start() {
  if (window.__WDAF_RUNNING) return;
  window.__WDAF_RUNNING = true;
  try {
    const data = await loadData();
    if (!data) {
      console.warn("[WDAF] No profile data saved.");
      window.__WDAF_RUNNING = false;
      return;
    }
    const profile = canonicalProfile(data);
    console.log("[WDAF] Starting autofill.");
    await runFlow(profile);
  } catch (e) {
    console.error("[WDAF] Error", e);
  } finally {
    window.__WDAF_RUNNING = false;
  }
}

async function runFlow(profile: ProfileData) {
  // Workday apps can be React-based with dynamic content.
  // Strategy: for each step, wait a moment, fill known fields, then click Continue.
  for (let i=0; i<12; i++) {
    await fillVisibleStep(profile);
    const advanced = clickByTexts(["save and continue", "continue", "next", "review", "submit", "ok"]);
    await sleep(1500);
    if (!advanced) {
      // try scrolling to trigger lazy mounts
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      await sleep(800);
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(700);
    }
  }
}

function text(el: Element | null | undefined) {
  return (el?.textContent || "").trim().toLowerCase();
}

async function fillVisibleStep(p: ProfileData) {
  // Generic fillers (labels + placeholders + ARIA)
  await fillByLabels(p);
  await fillWorkExperience(p.workExperiences || []);
  await fillEducation(p.educationExperiences || []);
  await fillProjects(p.projectExperiences || []);
  // common toggles
  toggleByQuestion("work authorization", p.workAuthorization ?? "Yes");
  toggleByQuestion("require visa", p.visaSponsorship ?? "No");
  toggleByQuestion("disability", p.disability ?? "No");
  toggleByQuestion("veteran", p.veteran ?? "No");
}

async function fillByLabels(p: ProfileData) {
  console.log("[WDAF] Starting fillByLabels with profile:", p);
  const inputs = Array.from(document.querySelectorAll("input, textarea, select")) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  console.log("[WDAF] Found", inputs.length, "form inputs");
  
  for (const el of inputs) {
    const label = nearestLabel(el);
    const hint = (label || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!hint) continue;

    console.log("[WDAF] Processing field:", { hint, element: el.tagName, type: el instanceof HTMLInputElement ? el.type : 'N/A' });

    let value: string | undefined;

    // email / phone immediate rules
    if (hint.includes("email")) value = p.email ?? randomEmail();
    else if (hint.includes("phone")) value = p.phoneNumber ?? randomPhone();
    else {
      // keyword mapping
      for (const key of Object.keys(FIELD_HINTS)) {
        if (hint.includes(key)) {
          console.log("[WDAF] Found keyword match:", key, "for hint:", hint);
          const candidates = FIELD_HINTS[key as keyof typeof FIELD_HINTS];
          for (const c of candidates) {
            const v = (p as any)[c];
            if (typeof v === "string" && v) { 
              value = v; 
              console.log("[WDAF] Using value:", value, "from field:", c);
              break; 
            }
          }
        }
        if (value) break;
      }
    }

    // name splits by heuristic
    if (!value) {
      if (hint.includes("first name") || hint.includes("given")) value = p.firstName ?? p.preferredName ?? "John";
      if (hint.includes("last name") || hint.includes("surname") || hint.includes("family")) value = p.lastName ?? "Doe";
      if (hint.includes("middle")) value = p.middleName ?? "M";
      if (hint.includes("address") && hint.includes("line 1")) value = p.address1;
      if (!value && hint.includes("city")) value = p.city;
      if (!value && (hint.includes("state") || hint.includes("province"))) value = p.state;
      if (!value && (hint.includes("zip") || hint.includes("postal"))) value = p.zip;
      if (!value && hint.includes("country")) value = p.country;
      if (!value && (hint.includes("linkedin"))) value = p.linkedinUrl;
      if (!value && (hint.includes("github"))) value = p.githubUrl;
      if (!value && (hint.includes("twitter"))) value = p.twitterUrl;
      if (!value && (hint.includes("date of birth") || hint.includes("dob"))) value = p.DoB;
    }

    // type-aware fill
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "").toLowerCase();
      if (type === "checkbox") {
        const yes = ["yes", "y", "true", "1"];
        const shouldCheck = yes.includes(String(value ?? "").toLowerCase());
        console.log("[WDAF] Checkbox:", hint, "value:", value, "shouldCheck:", shouldCheck);
        setCheckbox(el, shouldCheck);
        continue;
      }
      if (type === "radio") {
        // pick radio matching text
        const grp = document.querySelectorAll(`input[type=radio][name="${el.name}"]`);
        const label = nearestLabel(el)?.toLowerCase() ?? "";
        console.log("[WDAF] Radio button:", hint, "label:", label, "value:", value);
        if (value && label.includes(String(value).toLowerCase())) {
          console.log("[WDAF] Clicking radio button:", el);
          (el as HTMLInputElement).click();
        }
        continue;
      }
      if (type === "date") {
        if (value) setInputValue(el, value);
        continue;
      }
      if (type === "email" && !value) value = p.email ?? randomEmail();
      if (type === "tel" && !value) value = p.phoneNumber ?? randomPhone();
      if (!value) continue;
      setInputValue(el, String(value));
      continue;
    }
    if (el instanceof HTMLTextAreaElement) {
      if (!value) {
        // generic description fallback
        value = "Auto-filled via extension. Will provide details upon request.";
      }
      setInputValue(el, String(value));
      continue;
    }
    if (el instanceof HTMLSelectElement) {
      if (!value) continue;
      const options = Array.from(el.options);
      console.log("[WDAF] Dropdown:", hint, "value:", value, "options:", options.map(o => o.textContent?.trim()));
      const idx = options.findIndex(o => (o.textContent || "").trim().toLowerCase().includes(String(value).toLowerCase()));
      if (idx >= 0) { 
        console.log("[WDAF] Selecting dropdown option:", options[idx].textContent, "at index:", idx);
        el.selectedIndex = idx; 
        el.dispatchEvent(new Event("change", { bubbles: true })); 
      } else {
        console.log("[WDAF] No matching option found for:", value);
      }
      continue;
    }
  }
}

function nearestLabel(el: Element): string | null {
  // Try <label for=id>
  const id = (el as HTMLElement).id;
  if (id) {
    const l = document.querySelector(`label[for="${id}"]`);
    if (l) return l.textContent?.trim() ?? null;
  }
  // Try aria-labelledby
  const lb = el.getAttribute("aria-labelledby");
  if (lb) {
    const node = document.getElementById(lb);
    if (node) return node.textContent?.trim() ?? null;
  }
  // Walk up to find preceding label or field title
  let cur: Element | null = el.parentElement;
  for (let i=0; i<3 && cur; i++) {
    const lab = cur.querySelector("label, [data-automation-id='textInputBox']");
    if (lab && lab !== el) {
      const txt = lab.textContent?.trim();
      if (txt) return txt;
    }
    cur = cur.parentElement;
  }
  return null;
}

async function fillWorkExperience(exps: WorkExperience[]) {
  if (!exps.length) return;
  // Find "Add Work Experience" buttons and click as many times as needed
  const container = document.body;
  const addButtons = Array.from(container.querySelectorAll("button, [role='button'], a")).filter(b => {
    const t = (b.textContent || "").trim().toLowerCase();
    return t.includes("add") && (t.includes("experience") || t.includes("work"));
  }) as HTMLElement[];

  if (addButtons.length) {
    while (getVisibleExperienceCount() < exps.length) {
      addButtons[0].click();
      await sleep(800);
    }
  }

  // Fill visible experience forms heuristically
  const sections = findSectionsByHeader(["work experience", "experience"]);
  for (let i = 0; i < sections.length && i < exps.length; i++) {
    const s = sections[i];
    await fillExperienceSection(s, exps[i]);
  }
}

function getVisibleExperienceCount(): number {
  const sections = findSectionsByHeader(["work experience", "experience"]);
  return sections.length;
}

function findSectionsByHeader(keywords: string[]): HTMLElement[] {
  const result: HTMLElement[] = [];
  const all = Array.from(document.querySelectorAll("section, div"));
  for (const node of all) {
    const header = node.querySelector("h1,h2,h3,h4,[role='heading']");
    const t = (header?.textContent || "").trim().toLowerCase();
    if (t && keywords.some(k => t.includes(k))) {
      result.push(node as HTMLElement);
    }
  }
  return result;
}

async function fillExperienceSection(root: Element, exp: WorkExperience) {
  const map: Record<string, string|undefined> = {
    "title": exp.jobTitle,
    "job title": exp.jobTitle,
    "position": exp.jobTitle,
    "company": exp.companyName,
    "employer": exp.companyName,
    "location": exp.location,
    "description": exp.description,
    "start date": exp.startDate,
    "end date": exp.endDate,
    "from": exp.startDate,
    "to": exp.endDate,
    "work type": exp.workType
  };

  const inputs = Array.from(root.querySelectorAll("input, textarea, select")) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  for (const el of inputs) {
    const label = nearestLabelLocal(root, el);
    const hint = (label || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!hint) continue;

    let value: string | undefined;
    for (const key of Object.keys(map)) {
      if (hint.includes(key)) { value = map[key]; break; }
    }
    if (!value && el instanceof HTMLTextAreaElement && exp.description) value = exp.description;
    if (!value) continue;

    if (el instanceof HTMLInputElement) {
      if (el.type === "date") {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        setInputValue(el, value);
      }
    } else if (el instanceof HTMLTextAreaElement) {
      setInputValue(el, value);
    } else if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      const idx = options.findIndex(o => (o.textContent || "").trim().toLowerCase().includes(String(value).toLowerCase()));
      if (idx >= 0) { el.selectedIndex = idx; el.dispatchEvent(new Event("change", { bubbles: true })); }
    }
  }

  // Still working toggle
  if (exp.stillWorking !== undefined) {
    const cb = Array.from(root.querySelectorAll("input[type='checkbox']")).find(cb => {
      const lab = nearestLabelLocal(root, cb);
      return (lab||"").toLowerCase().includes("currently work") || (lab||"").toLowerCase().includes("present");
    }) as HTMLInputElement | undefined;
    if (cb) setCheckbox(cb, !!exp.stillWorking);
  }
}

function nearestLabelLocal(root: Element, el: Element): string | null {
  const id = (el as HTMLElement).id;
  if (id) {
    const l = root.querySelector(`label[for="${id}"]`);
    if (l) return l.textContent?.trim() ?? null;
  }
  const lb = el.getAttribute("aria-labelledby");
  if (lb) {
    const node = root.querySelector(`#${lb}`);
    if (node) return node.textContent?.trim() ?? null;
  }
  let cur: Element | null = el.parentElement;
  for (let i=0; i<3 && cur; i++) {
    const lab = cur.querySelector("label");
    if (lab && lab !== el) {
      const txt = lab.textContent?.trim();
      if (txt) return txt;
    }
    cur = cur.parentElement;
  }
  return null;
}

async function fillEducation(edus: EducationExperience[]) {
  if (!edus.length) return;
  const addButtons = Array.from(document.querySelectorAll("button, [role='button'], a")).filter(b => {
    const t = (b.textContent || "").trim().toLowerCase();
    return t.includes("add") && (t.includes("education") || t.includes("school"));
  }) as HTMLElement[];
  if (addButtons.length) {
    while (countEducationSections() < edus.length) { addButtons[0].click(); await sleep(600); }
  }
  const sections = findSectionsByHeader(["education"]);
  for (let i=0; i<sections.length && i<edus.length; i++) {
    const s = sections[i];
    const e = edus[i];
    await fillEduSection(s, e);
  }
}

function countEducationSections(): number {
  return findSectionsByHeader(["education"]).length;
}

async function fillEduSection(root: Element, edu: EducationExperience) {
  const map: Record<string, string|undefined> = {
    "school": edu.collegeName,
    "university": edu.collegeName,
    "institution": edu.collegeName,
    "degree": edu.educationType ?? "Bachelor",
    "field": edu.field,
    "major": edu.field,
    "start date": edu.startDate,
    "end date": edu.endDate,
    "from": edu.startDate,
    "to": edu.endDate,
    "grade": edu.grade,
    "gpa": edu.grade,
    "location": edu.location,
    "description": edu.description
  };
  const inputs = Array.from(root.querySelectorAll("input, textarea, select")) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  for (const el of inputs) {
    const label = nearestLabelLocal(root, el);
    const hint = (label || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!hint) continue;

    let value: string | undefined;
    for (const key of Object.keys(map)) {
      if (hint.includes(key)) { value = map[key]; break; }
    }
    if (!value) continue;

    if (el instanceof HTMLInputElement) {
      if (el.type === "date") {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        setInputValue(el, value);
      }
    } else if (el instanceof HTMLTextAreaElement) {
      setInputValue(el, value);
    } else if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      const idx = options.findIndex(o => (o.textContent || "").trim().toLowerCase().includes(String(value).toLowerCase()));
      if (idx >= 0) { el.selectedIndex = idx; el.dispatchEvent(new Event("change", { bubbles: true })); }
    }
  }
  if (edu.stillStudying !== undefined) {
    const cb = Array.from(root.querySelectorAll("input[type='checkbox']")).find(cb => {
      const lab = nearestLabelLocal(root, cb);
      return (lab||"").toLowerCase().includes("currently studying") || (lab||"").toLowerCase().includes("in progress");
    }) as HTMLInputElement | undefined;
    if (cb) setCheckbox(cb, !!edu.stillStudying);
  }
}

async function fillProjects(prjs: ProjectExperience[]) {
  if (!prjs.length) return;
  const addButtons = Array.from(document.querySelectorAll("button, [role='button'], a")).filter(b => {
    const t = (b.textContent || "").trim().toLowerCase();
    return t.includes("add") && t.includes("project");
  }) as HTMLElement[];
  if (addButtons.length) {
    while (countProjectSections() < prjs.length) { addButtons[0].click(); await sleep(600); }
  }
  const sections = findSectionsByHeader(["project"]);
  for (let i=0; i<sections.length && i<prjs.length; i++) {
    await fillProjectSection(sections[i], prjs[i]);
  }
}

function countProjectSections(): number {
  return findSectionsByHeader(["project"]).length;
}

async function fillProjectSection(root: Element, prj: ProjectExperience) {
  const map: Record<string, string|undefined> = {
    "name": prj.projectName,
    "project": prj.projectName,
    "start date": prj.startDate,
    "end date": prj.endDate,
    "from": prj.startDate,
    "to": prj.endDate,
    "description": prj.description,
    "github": prj.gitUrl,
    "url": prj.hostUrl,
    "link": prj.hostUrl
  };
  const inputs = Array.from(root.querySelectorAll("input, textarea, select")) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  for (const el of inputs) {
    const label = nearestLabelLocal(root, el);
    const hint = (label || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!hint) continue;

    let value: string | undefined;
    for (const key of Object.keys(map)) {
      if (hint.includes(key)) { value = map[key]; break; }
    }
    if (!value) continue;

    if (el instanceof HTMLInputElement) {
      if (el.type === "date") {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        setInputValue(el, value);
      }
    } else if (el instanceof HTMLTextAreaElement) {
      setInputValue(el, value);
    } else if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      const idx = options.findIndex(o => (o.textContent || "").trim().toLowerCase().includes(String(value).toLowerCase()));
      if (idx >= 0) { el.selectedIndex = idx; el.dispatchEvent(new Event("change", { bubbles: true })); }
    }
  }
}

function toggleByQuestion(keyword: string, answer: string | boolean) {
  const yesNo = String(answer).toLowerCase().startsWith("y") || String(answer) === "true";
  const groups = Array.from(document.querySelectorAll("fieldset, div"));
  for (const g of groups) {
    const label = g.querySelector("legend, h3, h4, label, [role='heading']");
    const t = (label?.textContent || "").trim().toLowerCase();
    if (t.includes(keyword)) {
      const radios = Array.from(g.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
      const targets = radios.filter(r => {
        const l = g.querySelector(`label[for="${r.id}"]`);
        const lt = (l?.textContent || "").trim().toLowerCase();
        return yesNo ? lt.includes("yes") : lt.includes("no");
      });
      if (targets[0]) targets[0].click();
    }
  }
}
