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
      '[class*="css-"][role="option"]',
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
        '[class*="css-"][role="option"]',
        'li[role="option"]',
        '[aria-selected]'
      ].join(', '))) as HTMLElement[];
      
      console.log("[WDAF] After typing, found options:", dropdownOptions.map(opt => opt.textContent?.trim()));
    }
    
    // Strategy 4: Find and click matching option
    for (const option of dropdownOptions) {
      const optionText = (option.textContent || "").trim().toLowerCase();
      
      // Skip "Select One" placeholder options
      if (optionText === 'select one') continue;
      
      // Enhanced matching logic for Workday's verbose options
      let isMatch = false;
      
      if (value.toLowerCase() === 'yes') {
        isMatch = optionText.includes('yes') && !optionText.includes('no');
      } else if (value.toLowerCase() === 'no') {
        isMatch = optionText.includes('no') || 
                 optionText.includes('not') || 
                 optionText.includes('do not');
      } else {
        // Fallback to original partial matching
        isMatch = optionText.includes(value.toLowerCase()) || value.toLowerCase().includes(optionText);
      }
      
      if (isMatch) {
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

async function handleUrlField(inputEl: HTMLInputElement, url: string) {
  console.log("[WDAF] Handling URL field with value:", url);
  
  try {
    // Clear the field first
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
    
    // Focus the field
    inputEl.focus();
    await sleep(100);
    
    // Set the URL value using the native setter
    const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputEl), "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(inputEl, url);
    } else {
      inputEl.value = url;
    }
    
    // Trigger comprehensive validation events
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(50);
    
    // Additional events that Workday might need for URL validation
    inputEl.dispatchEvent(new Event("keyup", { bubbles: true }));
    await sleep(50);
    inputEl.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(100);
    
    // Re-focus to trigger any final validation
    inputEl.focus();
    await sleep(50);
    inputEl.dispatchEvent(new Event("blur", { bubbles: true }));
    
    console.log("[WDAF] URL field filled and validated:", inputEl.value);
  } catch (error) {
    console.error("[WDAF] Error handling URL field:", error);
  }
}

async function handleCustomSelectOneDropdowns(p: ProfileData) {
  console.log("[WDAF] Looking for custom 'Select One' dropdowns");
  
  // Track processed questions to avoid duplicates
  const processedQuestions = new Set<string>();
  
  // Look for elements that contain "Select One" text, which indicates custom dropdowns
  const selectOneElements = Array.from(document.querySelectorAll('*')).filter(el => {
    const text = el.textContent?.trim() || '';
    return text === 'Select One' && el.tagName !== 'SCRIPT';
  });
  
  console.log("[WDAF] Found", selectOneElements.length, "Select One dropdowns");
  
  for (const selectOneEl of selectOneElements) {
    try {
      // Find the question text by looking at nearby elements
      const questionText = findQuestionForSelectOne(selectOneEl as HTMLElement);
      if (!questionText) continue;
      
      // Skip if we've already processed this question
      if (processedQuestions.has(questionText)) {
        console.log("[WDAF] Skipping duplicate question:", questionText);
        continue;
      }
      
      processedQuestions.add(questionText);
      console.log("[WDAF] Processing Select One dropdown for question:", questionText);
      
      // Determine the appropriate value based on the question
      const value = getValueForQuestion(questionText, p);
      if (!value) {
        console.log("[WDAF] No value found for question:", questionText);
        continue;
      }
      
      console.log("[WDAF] Using value:", value, "for question:", questionText);
      
      // Click the Select One element to open the dropdown
      (selectOneEl as HTMLElement).click();
      await sleep(300);
      
      // Look for dropdown options
      const options = Array.from(document.querySelectorAll([
        '[role="option"]',
        '[data-automation-id*="option"]',
        '[data-automation-id*="menuItem"]',
        'li[role="option"]',
        'div[role="option"]',
        '[class*="css-"][role="option"]',
        '.WDJT_option',
        '[aria-selected]',
        'li[data-automation-id*="option"]'
      ].join(', '))) as HTMLElement[];
      
      console.log("[WDAF] Found dropdown options:", options.map(opt => opt.textContent?.trim()));
      
      // Find and click the matching option
      for (const option of options) {
        const optionText = (option.textContent || '').trim().toLowerCase();
        
        // Skip "Select One" placeholder options
        if (optionText === 'select one') continue;
        
        // Enhanced matching logic for Workday's verbose options
        let isMatch = false;
        
        if (value.toLowerCase() === 'yes') {
          isMatch = optionText.includes('yes') && !optionText.includes('no');
        } else if (value.toLowerCase() === 'no') {
          isMatch = optionText.includes('no') || 
                   optionText.includes('not') || 
                   optionText.includes('do not');
        } else {
          // Fallback to original exact matching
          isMatch = optionText === value.toLowerCase();
        }
        
        if (isMatch) {
          console.log("[WDAF] Clicking option:", optionText);
          option.click();
          await sleep(200);
          break;
        }
      }
      
    } catch (error) {
      console.error("[WDAF] Error handling Select One dropdown:", error);
    }
  }
}

function findQuestionForSelectOne(selectOneEl: HTMLElement): string | null {
  // Look for question text in parent elements
  let parent = selectOneEl.parentElement;
  let attempts = 0;
  
  while (parent && attempts < 5) {
    const questionElements = Array.from(parent.querySelectorAll('*'));
    for (const el of questionElements) {
      const text = el.textContent?.trim() || '';
      if (text.includes('?') && text.length > 20 && text.length < 500) {
        // This looks like a question
        return text.toLowerCase();
      }
    }
    parent = parent.parentElement;
    attempts++;
  }
  
  return null;
}

function getValueForQuestion(question: string, p: ProfileData): string | null {
  const q = question.toLowerCase();
  
  if (q.includes('consider relocating') || q.includes('relocating for this role')) {
    return p.willingToRelocate || 'Yes';
  } else if (q.includes('non-compete') || q.includes('non-solicitation') || q.includes('restrictions')) {
    return p.nonCompeteRestrictions || 'No';
  } else if (q.includes('workday system') || q.includes('work on the workday')) {
    return p.workdaySystemExperience || 'No';
  } else if (q.includes('authorized to work') || q.includes('work in the country')) {
    return p.workAuthorizedInCountry || 'Yes';
  } else if (q.includes('visa sponsorship') || q.includes('immigration filing') || q.includes('work permit')) {
    return p.requiresVisaSponsorship || 'No';
  } else if (q.includes('federal government') || q.includes('military officer') || q.includes('u.s. federal')) {
    return p.federalGovernmentEmployee || 'No';
  } else if (q.includes('export control') || q.includes('iran, cuba, north korea') || q.includes('current citizen')) {
    return p.exportControlCountries || 'No';
  } else if (q.includes('related to a current workday') || q.includes('workday employee')) {
    return p.relatedToWorkdayEmployee || 'No';
  } else if (q.includes('related to an employee') || q.includes('customer employee') || q.includes('government official')) {
    return p.relatedToCustomerEmployee || 'No';
  } else if (q.includes('i acknowledge') || q.includes('read, understood') || q.includes('truthfully and accurately')) {
    return p.acknowledgeTermsAndConditions || 'Yes';
  }
  
  return null;
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
  
  // Also handle custom "Select One" dropdowns
  await handleCustomSelectOneDropdowns(p);
  
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
          } else if (questionContext.includes("consider relocating") || questionContext.includes("relocating for this role")) {
            value = p.willingToRelocate;
            console.log("[WDAF] Inferred relocating value:", value);
          } else if (questionContext.includes("non-compete") || questionContext.includes("non-solicitation") || questionContext.includes("restrictions")) {
            value = p.nonCompeteRestrictions;
            console.log("[WDAF] Inferred non-compete value:", value);
          } else if (questionContext.includes("workday system") || questionContext.includes("work on the workday")) {
            value = p.workdaySystemExperience;
            console.log("[WDAF] Inferred workday system value:", value);
          } else if (questionContext.includes("authorized to work") || questionContext.includes("work in the country")) {
            value = p.workAuthorizedInCountry;
            console.log("[WDAF] Inferred work authorization value:", value);
          } else if (questionContext.includes("visa sponsorship") || questionContext.includes("immigration filing") || questionContext.includes("work permit")) {
            value = p.requiresVisaSponsorship;
            console.log("[WDAF] Inferred visa sponsorship value:", value);
          } else if (questionContext.includes("federal government") || questionContext.includes("military officer") || questionContext.includes("u.s. federal")) {
            value = p.federalGovernmentEmployee;
            console.log("[WDAF] Inferred federal government value:", value);
          } else if (questionContext.includes("export control") || questionContext.includes("iran, cuba, north korea") || questionContext.includes("current citizen")) {
            value = p.exportControlCountries;
            console.log("[WDAF] Inferred export control value:", value);
          } else if (questionContext.includes("related to a current workday") || questionContext.includes("workday employee")) {
            value = p.relatedToWorkdayEmployee;
            console.log("[WDAF] Inferred workday employee relation value:", value);
          } else if (questionContext.includes("related to an employee") || questionContext.includes("customer employee") || questionContext.includes("government official")) {
            value = p.relatedToCustomerEmployee;
            console.log("[WDAF] Inferred customer employee relation value:", value);
          } else if (questionContext.includes("i acknowledge") || questionContext.includes("read, understood") || questionContext.includes("truthfully and accurately")) {
            value = p.acknowledgeTermsAndConditions;
            console.log("[WDAF] Inferred acknowledgment value:", value);
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
      
      // Special handling for URL fields that need extra validation
      if (hint.includes("linkedin") || hint.includes("url") || hint.includes("website") || hint.includes("portfolio")) {
        console.log("[WDAF] Detected URL field:", hint, "value:", value);
        await handleUrlField(el, String(value));
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
