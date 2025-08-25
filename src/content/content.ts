import type { ProfileData, WorkExperience, EducationExperience, ProjectExperience } from "@shared/types";
import { loadData } from "@shared/storage";
import { canonicalProfile, FIELD_HINTS } from "@shared/mapping";
import { sleep, waitForElement, setInputValue, setCheckbox, clickByTexts } from "@shared/dom";
import { randomEmail, randomPhone, randomString } from "@shared/random";

declare global {
  interface Window { __WDAF_RUNNING?: boolean }
}

console.log("[WDAF] Content script loaded on:", location.href);

// Singleton guard to prevent multiple runs
declare global {
  interface Window {
    __WDAF_RUNNING?: boolean;
    __WDAF_INITIALIZED?: boolean;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[WDAF] Received message:", message);
  if (message?.type === "START_AUTOFILL") {
    start().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      console.error("[WDAF] Start error:", error);
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

function waitForForm(callback: () => void, maxWaitTime = 10000) {
  const startTime = Date.now();
  const interval = setInterval(() => {
    const inputs = document.querySelectorAll("input, textarea, select");
    if (inputs.length > 0) {
      clearInterval(interval);
      console.log("[WDAF] Form elements found, starting autofill.");
      callback();
    } else if (Date.now() - startTime > maxWaitTime) {
      clearInterval(interval);
      console.log("[WDAF] Timeout waiting for form elements.");
      callback(); // Proceed anyway
    }
  }, 300);
}

function getRadioQuestionContext(radio: HTMLInputElement): string {
  // Try <fieldset><legend> first
  const fieldset = radio.closest("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend) {
      const text = legend.textContent?.trim();
      if (text && text.length > 5) return text.toLowerCase();
    }
  }

  // Try parent elements for question text
  let parent = radio.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    // Look for headings or question elements
    const questionEl = parent.querySelector("h1, h2, h3, h4, h5, h6, [role='heading'], .question, [data-automation-id*='question']");
    if (questionEl) {
      const text = questionEl.textContent?.trim();
      if (text && text.length > 5 && !text.match(/^(yes|no|y|n)$/i)) {
        return text.toLowerCase();
      }
    }

    // Check for text nodes with question-like content
    const walker = document.createTreeWalker(
      parent,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const text = node.textContent?.trim() || "";
          return text.length > 10 && text.includes("?") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const textNode = walker.nextNode();
    if (textNode) {
      const text = textNode.textContent?.trim();
      if (text) return text.toLowerCase();
    }

    parent = parent.parentElement;
  }

  // Fallback: check for aria-describedby or nearby labels
  const ariaDescribedBy = radio.getAttribute("aria-describedby");
  if (ariaDescribedBy) {
    const descElement = document.getElementById(ariaDescribedBy);
    if (descElement) {
      const text = descElement.textContent?.trim();
      if (text && text.length > 5) return text.toLowerCase();
    }
  }

  return "";
}

async function handleCustomDropdown(inputEl: HTMLInputElement, value: string, hint: string) {
  console.log("[WDAF] Handling custom dropdown:", hint, "target value:", value);
  
  try {
    // Strategy 1: Click the input to trigger dropdown
    inputEl.focus();
    await sleep(100);
    inputEl.click();
    await sleep(300);
    
    // Strategy 2: Look for dropdown options that appeared
    let dropdownOptions = Array.from(document.querySelectorAll([
      '[role="option"]',
      '[data-automation-id*="option"]', 
      '[data-automation-id*="menuItem"]',
      '.WDJT_option',
      '.css-*[role="option"]',
      'li[role="option"]',
      '[aria-selected]'
    ].join(', '))) as HTMLElement[];
    
    console.log("[WDAF] Found dropdown options:", dropdownOptions.map(opt => opt.textContent?.trim()));
    
    if (dropdownOptions.length === 0) {
      // Strategy 3: Try typing to trigger autocomplete
      inputEl.value = "";
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(100);
      
      // Type the value character by character
      for (let i = 0; i < value.length; i++) {
        inputEl.value = value.substring(0, i + 1);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(50);
      }
      
      await sleep(300);
      
      // Look for options again
      dropdownOptions = Array.from(document.querySelectorAll([
        '[role="option"]',
        '[data-automation-id*="option"]', 
        '[data-automation-id*="menuItem"]',
        '.WDJT_option',
        'li[role="option"]',
        '[aria-selected]'
      ].join(', '))) as HTMLElement[];
      
      console.log("[WDAF] After typing, found options:", dropdownOptions.map(opt => opt.textContent?.trim()));
    }
    
    // Strategy 4: Find and click matching option
    for (const option of dropdownOptions) {
      const optionText = (option.textContent || "").trim().toLowerCase();
      if (optionText.includes(value.toLowerCase()) || value.toLowerCase().includes(optionText)) {
        console.log("[WDAF] Clicking dropdown option:", option.textContent);
        option.click();
        await sleep(100);
        return;
      }
    }
    
    // Strategy 5: Try arrow keys if no direct match
    if (dropdownOptions.length > 0) {
      console.log("[WDAF] No exact match, trying arrow keys navigation");
      inputEl.focus();
      
      // Press down arrow to highlight first option
      inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await sleep(100);
      
      // Try up to 10 arrow down presses to find our option
      for (let i = 0; i < Math.min(10, dropdownOptions.length); i++) {
        // Check if current highlighted option matches
        const activeOption = document.querySelector('[aria-selected="true"], .highlighted, .selected') as HTMLElement;
        if (activeOption) {
          const activeText = (activeOption.textContent || "").trim().toLowerCase();
          if (activeText.includes(value.toLowerCase())) {
            console.log("[WDAF] Found match with arrow keys:", activeOption.textContent);
            inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await sleep(100);
            return;
          }
        }
        
        // Move to next option
        inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await sleep(100);
      }
    }
    
    console.log("[WDAF] Could not select dropdown option for:", value);
  } catch (error) {
    console.error("[WDAF] Error handling custom dropdown:", error);
  }
}

async function start() {
  if (window.__WDAF_RUNNING || window.__WDAF_INITIALIZED) return;
  window.__WDAF_RUNNING = true;
  window.__WDAF_INITIALIZED = true;
  
  try {
    const data = await loadData();
    if (!data) {
      console.warn("[WDAF] No profile data saved.");
      window.__WDAF_RUNNING = false;
      return;
    }
    const profile = canonicalProfile(data);
    console.log("[WDAF] Starting autofill.");
    
    // Wait for form elements before starting
    waitForForm(() => {
      runFlow(profile);
    });
  } catch (e) {
    console.error("[WDAF] Error", e);
  } finally {
    window.__WDAF_RUNNING = false;
  }
}

async function runFlow(profile: ProfileData) {
  // Reduced iterations and better control to prevent excessive repetition
  for (let i = 0; i < 3; i++) {
    console.log(`[WDAF] Autofill iteration ${i + 1}/3`);
    await fillVisibleStep(profile);
    
    // Try to advance to next step
    const advanced = clickByTexts(["save and continue", "continue", "next", "review", "submit", "ok"]);
    await sleep(2000); // Longer wait between attempts
    
    if (!advanced) {
      // Try scrolling to trigger lazy mounts
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      await sleep(1000);
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(1000);
    } else {
      // If we successfully advanced, wait longer for new page to load
      await sleep(3000);
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
  
  // Skip if no inputs found to prevent spam
  if (inputs.length === 0) {
    return;
  }
  
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
      // keyword mapping - check longer matches first
      const sortedKeys = Object.keys(FIELD_HINTS).sort((a, b) => b.length - a.length);
      for (const key of sortedKeys) {
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
        // Get the actual question context using improved detection
        const questionContext = getRadioQuestionContext(el);
        
        console.log("[WDAF] Radio button:", hint, "questionContext:", questionContext, "label:", nearestLabel(el)?.toLowerCase() ?? "", "value:", value);
        
        // If no value found yet, try to infer from question context
        if (!value && questionContext) {
          if (questionContext.includes("previously worked") || questionContext.includes("worked for") || questionContext.includes("nvidia") || questionContext.includes("employee or contractor")) {
            value = p.previouslyWorkedForCompany;
            console.log("[WDAF] Inferred radio value from question context:", value);
          }
        }
        
        const label = nearestLabel(el)?.toLowerCase() ?? "";
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
      
      // Special handling for phone-related fields
      if (hint.includes("country phone code") || hint.includes("phone code")) {
        value = p.phoneCode || "+1";
      } else if (hint.includes("phone number") && !hint.includes("country")) {
        // Extract just the number part without country code
        const phoneNum = p.phoneNumber || randomPhone();
        value = phoneNum.replace(/^\+\d+/, "").replace(/\D/g, ""); // Remove country code and non-digits
      } else if (hint.includes("device type") || hint.includes("phone device")) {
        value = p.phoneDeviceType || "Mobile";
      }
      
      if (!value) continue;
      
      // Special handling for Workday custom dropdowns
      if (hint.includes("how did you hear") || hint.includes("device type") || hint.includes("source")) {
        console.log("[WDAF] Detected custom dropdown field:", hint, "value:", value);
        await handleCustomDropdown(el, String(value), hint);
        continue;
      }
      
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
      
      // Try exact match first, then partial match
      let idx = options.findIndex(o => (o.textContent || "").trim().toLowerCase() === String(value).toLowerCase());
      if (idx < 0) {
        idx = options.findIndex(o => (o.textContent || "").trim().toLowerCase().includes(String(value).toLowerCase()));
      }
      
      if (idx >= 0) { 
        console.log("[WDAF] Selecting dropdown option:", options[idx].textContent, "at index:", idx);
        el.selectedIndex = idx; 
        el.dispatchEvent(new Event("change", { bubbles: true })); 
        el.dispatchEvent(new Event("input", { bubbles: true })); 
      } else {
        console.log("[WDAF] No matching option found for:", value);
        console.log("[WDAF] Available options:", options.map(o => `"${o.textContent?.trim()}"`));
      }
      continue;
    }
    
    // Check for custom dropdowns or combobox elements
    if ((el as HTMLElement).getAttribute("role") === "combobox" || (el as HTMLElement).getAttribute("aria-haspopup") === "listbox") {
      console.log("[WDAF] Custom dropdown detected:", hint, "value:", value);
      if (value) {
        // Try clicking to open dropdown
        (el as HTMLElement).click();
        await sleep(300);
        // Look for dropdown options
        const dropdownOptions = Array.from(document.querySelectorAll('[role="option"], [data-automation-id*="option"]'));
        console.log("[WDAF] Found dropdown options:", dropdownOptions.map(opt => opt.textContent?.trim()));
        for (const option of dropdownOptions) {
          if ((option.textContent || "").toLowerCase().includes(String(value).toLowerCase())) {
            console.log("[WDAF] Clicking custom dropdown option:", option.textContent);
            (option as HTMLElement).click();
            break;
          }
        }
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
