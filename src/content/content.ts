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
    async function handleCustomSelectOneDropdowns(p: ProfileData) {
      console.log("[WDAF] Looking for custom 'Select One' dropdowns");

      // Track processed (normalized) questions across this invocation
      const processedQuestions = new Set<string>();

      // Collect every visible element that literally contains the text 'Select One'
      const selectOneElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const txt = (el.textContent || '').trim();
        if (txt !== 'Select One') return false;
        const style = window.getComputedStyle(el as HTMLElement);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });

      console.log(`[WDAF] Found ${selectOneElements.length} Select One dropdowns`);

      // Helper: normalize question text to dedupe (strip trailing * and 'select one')
      const normalizeQuestion = (q: string) => q
        .replace(/select one/i, '')
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      // Helper: attempt to locate the clickable control for a given 'Select One' marker
      const findClickable = (marker: HTMLElement): HTMLElement | null => {
        // Common patterns: a button / div with role=button / combobox near the text node
        // Search siblings first
        const container = marker.closest('[data-automation-id]') || marker.parentElement || marker;
        if (!container) return null;
        const candidates = Array.from(new Set([
          ...Array.from(container.querySelectorAll<HTMLElement>('button[aria-haspopup], button:not([disabled])')),
          ...Array.from(container.querySelectorAll<HTMLElement>('[role="button"], [role="combobox"], [aria-haspopup="listbox"]')),
          ...Array.from(container.querySelectorAll<HTMLElement>('div[tabindex], span[tabindex]'))
        ])).filter(el => el.offsetParent !== null);
        // Heuristic: prefer element that is BEFORE or wraps the text node OR has aria-haspopup
        const prioritized = candidates.sort((a,b)=>{
          const aScore = (a.getAttribute('aria-haspopup') ? 10:0) + (a.contains(marker)?5:0);
          const bScore = (b.getAttribute('aria-haspopup') ? 10:0) + (b.contains(marker)?5:0);
          return bScore - aScore;
        });
        return prioritized[0] || null;
      };

      // Helper: retrieve dropdown options with retries
      const collectOptions = async (retries = 6): Promise<HTMLElement[]> => {
        for (let i=0;i<retries;i++) {
          const opts = Array.from(document.querySelectorAll<HTMLElement>([
            '[role="option"]',
            '[data-automation-id*="option"]',
            '[data-automation-id*="menuItem"]',
            'li[role="option"]',
            'div[role="option"]',
            '.WDJT_option',
            '[aria-selected][role="option"]',
            '[id*="option"][role="option"]'
          ].join(','))).filter(o => (o.textContent||'').trim().length>0);
          if (opts.length) return opts;
          await sleep(200 + i*50);
        }
        return [];
      };

      // Helper: open dropdown robustly
      const openDropdown = async (clickable: HTMLElement) => {
        // Sequence of events to satisfy React / Workday handlers
        const fire = (type: string) => clickable.dispatchEvent(new MouseEvent(type, {bubbles:true}));
        fire('pointerdown'); fire('mousedown');
        clickable.focus();
        fire('mouseup'); fire('click');
        // Keyboard fallback if no options appear quickly
        await sleep(150);
      };

      // (Old implementation removed)
    }
  } catch (e) {
    console.error('[WDAF] Error in custom dropdown handler', e);
  }
}

// Re-introduced helper: locate the full question text associated with a 'Select One' marker
function findQuestionForSelectOne(marker: HTMLElement): string | null {
  // Strategy 1: ascend parents (broaden criteria, remove upper length cap)
  let parent: HTMLElement | null = marker.parentElement;
  for (let depth = 0; parent && depth < 10; depth++) {
    const blockText = (parent.textContent || '').trim();
    if (blockText.length > 12) {
      const lower = blockText.toLowerCase();
      if (/[?]/.test(blockText) || /i acknowledge|workday|relocat|visa|sponsor|authorized|non-compete|export control|previously worked|citizenship|residency/i.test(blockText)) {
        // Ignore if it's clearly navigation or massive concatenated page chrome
        if (/skip to main content|candidate home|job alerts/.test(lower)) return null;
        return lower;
      }
    }
    parent = parent.parentElement;
  }

  // Strategy 2: previous siblings aggregation
  const prevTexts: string[] = [];
  let sib: HTMLElement | null = marker.previousElementSibling as HTMLElement | null;
  while (sib && prevTexts.join(' ').length < 1600) {
    const t = (sib.textContent || '').trim();
    if (t) prevTexts.unshift(t);
    if (t.length > 8) {
      if (/[?]/.test(t) || /i acknowledge|workday|relocat|visa|sponsor|authorized|non-compete|export control|previously worked/i.test(t)) {
        return prevTexts.join(' ').toLowerCase();
      }
    }
    sib = sib.previousElementSibling as HTMLElement | null;
  }

  // Strategy 3: look for closest heading above
  let probe: HTMLElement | null = marker.parentElement;
  for (let depth = 0; probe && depth < 8; depth++) {
    const heading = probe.querySelector('h1,h2,h3,h4,h5,[role="heading"]');
    if (heading) {
      const ht = (heading.textContent || '').trim();
  if (ht.length > 8 && (/[?]/.test(ht) || /i acknowledge|workday|relocat|visa|sponsor|authorized|non-compete|export control|previously worked|citizenship|residency/i.test(ht))) return ht.toLowerCase();
    }
    probe = probe.parentElement;
  }
  return null;
}

// Re-introduced URL field handler (simple normalization + validation)
async function handleUrlField(input: HTMLInputElement, value: string) {
  try {
    let v = value.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      v = 'https://' + v.replace(/^\/+/,'');
    }
    // Basic LinkedIn normalization
    if (/linkedin\.com\/in\//i.test(v)) {
      v = v.split('?')[0].split('#')[0];
      if (!v.endsWith('/')) v += '/';
    }
    setInputValue(input, v);
  } catch (e) {
    console.error('[WDAF] URL handling error', e);
  }
}

// Clean replacement robust handler
// Global processed memory to reduce repeated toggling across observer-triggered runs
const globalProcessedDropdownQuestions = new Set<string>();
let lastDropdownRun = 0;
// Hardcoded fallback answers (can be expanded)
const HARD_CODED_DROPDOWN_ANSWERS: { test: RegExp; answer: string }[] = [
  { test: /would you consider relocating/i, answer: 'Yes' },
  { test: /non-compete|non\s*solicitation/i, answer: 'No' },
  { test: /authorized to work/i, answer: 'Yes' },
  { test: /visa sponsorship|immigration filing/i, answer: 'No' },
  { test: /federal government|military officer/i, answer: 'No' },
  { test: /export control|iran|cuba|north korea|crimea|donetsk|luhansk|syria/i, answer: 'No' },
  { test: /related to a current workday employee/i, answer: 'No' },
  { test: /related to an employee of a customer|government official/i, answer: 'No' },
  { test: /acknowledge.*answered them truthfully/i, answer: 'Yes' },
  { test: /additional country|citizenship.*additional/i, answer: 'No' },
  { test: /most recently acquired form of citizenship/i, answer: 'No' },
  { test: /gender$/i, answer: 'Prefer not to say' },
  { test: /i acknowledge workday’s recruitment privacy statement and vibe philosophy/i, answer: 'Yes' }
];
// Track per-question attempts to prevent infinite loops
const dropdownAttemptCounts: Record<string, number> = {};
async function handleCustomSelectOneDropdowns(p: ProfileData) {
  const now = Date.now();
  if (now - lastDropdownRun < 300) { return; } // throttle
  lastDropdownRun = now;
  const markers = Array.from(document.querySelectorAll('*')).filter(el => (el.textContent||'').trim() === 'Select One');
  if (!markers.length) return;
  console.log('[WDAF] Select One markers:', markers.length);
  const processed = new Set<string>();

  const normalize = (q:string)=> {
    let cleaned = q.replace(/select one/i,'').replace(/\*/g,'');
    // If there's a question mark, keep up to (and including) first '?'
    const qm = cleaned.indexOf('?');
    if (qm !== -1) cleaned = cleaned.slice(0, qm+1);
    // Remove trailing concatenated yes/no answer tokens stuck to question
    cleaned = cleaned.replace(/\b(yes|no)(?:\s*,?\s*)?$/i,'');
    cleaned = cleaned.replace(/\s+/g,' ').trim().toLowerCase();
    return cleaned;
  };
  const findClickable = (m:HTMLElement):HTMLElement|null => {
    const container = m.closest('[data-automation-id]') || m.parentElement || m;
    if (!container) return null;
    const list: HTMLElement[] = [];
    ['button[aria-haspopup]','button:not([disabled])','[role="button"]','[role="combobox"]','[aria-haspopup="listbox"]','div[tabindex]','span[tabindex]']
      .forEach(sel => Array.from(container.querySelectorAll<HTMLElement>(sel)).forEach(e => list.push(e)));
    const visible = list.filter(e=>e.offsetParent!==null);
    visible.sort((a,b)=>((b.getAttribute('aria-haspopup')?10:0)+(b.contains(m)?5:0)) - ((a.getAttribute('aria-haspopup')?10:0)+(a.contains(m)?5:0)) );
    return visible[0] || null;
  };
  const collect = async():Promise<HTMLElement[]> => {
    for (let i=0;i<6;i++) {
      const opts = Array.from(document.querySelectorAll<HTMLElement>([
        '[role="option"]','[data-automation-id*="option"]','[data-automation-id*="menuItem"]','li[role="option"]','div[role="option"]','.WDJT_option','[aria-selected][role="option"]','[id*="option"][role="option"]'
      ].join(','))).filter(o => (o.textContent||'').trim());
      if (opts.length) return opts;
      await sleep(200 + i*80);
    }
    return [];
  };
  const open = async(el:HTMLElement)=>{['pointerdown','mousedown','mouseup','click'].forEach(t=>el.dispatchEvent(new MouseEvent(t,{bubbles:true}))); el.focus(); await sleep(180);};

  for (const m of markers) {
    try {
      let raw = findQuestionForSelectOne(m as HTMLElement) || '';
      if (!raw) {
        const parentTxt = (m.parentElement?.textContent||'').trim();
        if (parentTxt.length>10) raw = parentTxt;
      }
  if (!raw) { console.log('[WDAF] Dropdown skip: no raw question text found'); continue; }
  let norm = normalize(raw);
      if (!norm) { console.log('[WDAF] Dropdown skip: normalized empty from raw', raw); continue; }
  if (processed.has(norm) || globalProcessedDropdownQuestions.has(norm)) { console.log('[WDAF] Dropdown skip: already processed', norm); continue; }
  // Ignore super short or trivial option-only blocks
  if (norm === 'yes' || norm === 'no' || norm === 'yesno' || norm.length < 6) { console.log('[WDAF] Dropdown skip: trivial norm', norm); continue; }
  // Ignore massive blocks that likely contain all options flattened
      if (norm.length > 420 && !/\?/.test(norm) && !/i acknowledge/.test(norm)) {
        // Attempt to extract sub-question lines like 'Gender' or acknowledgment within large voluntary disclosure text
        const rawLower = raw.toLowerCase();
        let extracted: string | null = null;
        if (/\bgender\b/i.test(raw)) extracted = 'gender';
        if (/i acknowledge workday[’'`]?s recruitment privacy statement and vibe philosophy/i.test(raw)) {
          extracted = 'i acknowledge workday’s recruitment privacy statement and vibe philosophy';
        }
        if (extracted) {
          console.log('[WDAF] Extracted sub-question from oversized block ->', extracted);
        } else {
          console.log('[WDAF] Dropdown skip: oversized block', norm.slice(0,120)+'...');
          continue;
        }
        if (extracted) {
          // override norm and allow processing
          raw = extracted;
        }
      }
      // Re-normalize if we overrode raw
      const finalNorm = normalize(raw);
      const normWas = norm;
      if (finalNorm !== norm) {
        norm = finalNorm;
      }
      // Skip country / territory phone code or country selection blocks (handled elsewhere by label fill)
      if (/^country\s*\/\s*territory$/.test(norm) || /phone code/.test(norm)) { console.log('[WDAF] Dropdown skip: country/territory meta', norm); continue; }
      // Skip flattened multi-option Workday system answers (they contain multiple 'yes,' occurrences)
      if (/yes, i work for a partner implementing or supporting workday projects/.test(norm) && /yes, i am directly involved/.test(norm)) { console.log('[WDAF] Dropdown skip: flattened workday options list'); continue; }
  let val = getValueForQuestion(norm, p);
      if (!val && /i acknowledge|truthfully and accurately/i.test(norm)) val = 'Yes';
      if (!val) {
        const hard = HARD_CODED_DROPDOWN_ANSWERS.find(h => h.test.test(norm));
        if (hard) val = hard.answer;
      }

      // If still no value, try heuristic: open and inspect options first
      let optsPreview: HTMLElement[] = [];
      if (!val) {
        const clickablePreview = findClickable(m as HTMLElement) || (m as HTMLElement);
        await open(clickablePreview);
        optsPreview = await collect();
        // Heuristic: if only Yes/No present choose mapped default based on keywords
        const texts = optsPreview.map(o => (o.textContent||'').trim().toLowerCase());
        if (texts.filter(t=>/yes|no/.test(t)).length >= 2) {
          // Map by keyword presence
            if (/relocat/.test(norm)) val = p.willingToRelocate || 'Yes';
            else if (/previously worked|worked for|employee or contractor/.test(norm)) val = p.previouslyWorkedForCompany || 'No';
            else if (/non-compete|non\s*solicitation|restrictions/.test(norm)) val = p.nonCompeteRestrictions || 'No';
            else if (/workday system/.test(norm)) val = p.workdaySystemExperience || 'No';
            else if (/authorized to work|work in the country/.test(norm)) val = p.workAuthorizedInCountry || 'Yes';
            else if (/visa|sponsorship|immigration/.test(norm)) val = p.requiresVisaSponsorship || 'No';
            else if (/federal government|military/.test(norm)) val = p.federalGovernmentEmployee || 'No';
            else if (/export control|iran|cuba|north korea|crimea/.test(norm)) val = p.exportControlCountries || 'No';
            else if (/related to.*workday employee/.test(norm)) val = p.relatedToWorkdayEmployee || 'No';
            else if (/related to.*customer|government official/.test(norm)) val = p.relatedToCustomerEmployee || 'No';
        }
      }

  if (!val) { console.log('[WDAF] Dropdown skip: no value resolved for question:', norm.slice(0,200)); continue; }
      // Cap attempts per normalized question
      dropdownAttemptCounts[norm] = dropdownAttemptCounts[norm] || 0;
      if (dropdownAttemptCounts[norm] > 6) { console.log('[WDAF] Dropdown skip: max attempts reached for', norm); continue; }
      dropdownAttemptCounts[norm]++;
      console.log('[WDAF] Dropdown attempt', dropdownAttemptCounts[norm], 'for', norm.slice(0,160), '->', val);
      const clickable = findClickable(m as HTMLElement) || (m as HTMLElement);
      await open(clickable);
      let opts = optsPreview.length ? optsPreview : await collect();
      if (!opts.length) { clickable.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); await sleep(150); opts = await collect(); }
      if (!opts.length) { console.log('[WDAF] No options after open for question:', norm.slice(0,120)); continue; }
      const target = val.toLowerCase();
      const match = opts.find(o => { 
        const t=(o.textContent||'').trim().toLowerCase(); 
        if(!t) return false; 
        // Specialized mapping for Workday system interaction multi-option question
        if (/workday system/.test(norm)) {
          // Normalize desired answer: if target yes -> choose strongest yes option (partner implementing > directly involved > occasionally use)
          if (target.startsWith('y')) {
            if (/partner implementing/.test(t)) return true;
            if (/directly involved/.test(t)) return true;
            if (/occasionally use/.test(t)) return true;
          } else if (target.startsWith('n')) {
            if (/do not use the workday system/.test(t)) return true;
          }
        }
        if(['yes','no'].includes(target)){
          if(target==='yes') return /\byes\b/.test(t) && !/not able|no,/.test(t);
          if(target==='no') return /\bno\b/.test(t) && !/not.*yes|yes/.test(t);
        }
        return t===target || t.startsWith(target+' ') || t.includes(target);
      });
      const chosen = match || opts.find(o=>!/(select one|choose|--)/i.test((o.textContent||'')));
      if (chosen) { 
        const choiceText = (chosen.textContent||'').trim();
        console.log('[WDAF] Choosing:', choiceText); 
        // More robust event sequence for React/Workday
        ['pointerover','pointerdown','mousedown','mouseup','click'].forEach(evt=>{
          chosen.dispatchEvent(new MouseEvent(evt,{bubbles:true}));
        });
        chosen.dispatchEvent(new Event('change',{bubbles:true}));
        await sleep(160);
        // Post-selection verification
        const container = clickable.closest('[data-automation-id]') as HTMLElement | null;
        const applied = (()=>{
          if ((m.textContent||'').trim() !== 'Select One') return true;
          if (container && container.textContent?.toLowerCase().includes(target)) return true;
          const selectedOpt = opts.find(o=> /aria-selected="true"/i.test(o.outerHTML) || o.getAttribute('aria-selected')==='true');
          if (selectedOpt && (selectedOpt.textContent||'').trim().toLowerCase().includes(target)) return true;
          return false;
        })();
        if (applied) {
          processed.add(norm);
          globalProcessedDropdownQuestions.add(norm);
        } else {
          console.log('[WDAF] Selection not confirmed yet (attempt', dropdownAttemptCounts[norm], '):', norm.slice(0,80));
          // Fallback: keyboard navigation retry soon if under attempt cap
          if (dropdownAttemptCounts[norm] <= 6) {
            setTimeout(()=>{ handleCustomSelectOneDropdowns(p); }, 400 + dropdownAttemptCounts[norm]*120);
          }
        }
      } else { console.log('[WDAF] No suitable option found for target', target, 'options sample:', opts.slice(0,5).map(o=> (o.textContent||'').trim().toLowerCase())); }
    } catch(err){ console.error('[WDAF] Dropdown error', err); }
  }
}

function getValueForQuestion(question: string, p: ProfileData): string | null {
  const q = question.toLowerCase();
  if (q.includes('consider relocating')) return p.willingToRelocate || 'Yes';
  if (q.includes('non-compete') || q.includes('non-solicitation')) return p.nonCompeteRestrictions || 'No';
  if (q.includes('workday system')) return p.workdaySystemExperience || 'No';
  if (q.includes('authorized to work')) return p.workAuthorizedInCountry || 'Yes';
  if (q.includes('visa sponsorship') || q.includes('immigration')) return p.requiresVisaSponsorship || 'No';
  if (q.includes('federal government') || q.includes('military')) return p.federalGovernmentEmployee || 'No';
  if (q.includes('export control') || q.includes('iran') || q.includes('cuba') || q.includes('north korea') || q.includes('crimea')) return p.exportControlCountries || 'No';
  if (q.includes('related to') && q.includes('workday')) return p.relatedToWorkdayEmployee || 'No';
  if (q.includes('related to') && (q.includes('customer') || q.includes('government'))) return p.relatedToCustomerEmployee || 'No';
  if (q.includes('i acknowledge') || q.includes('truthfully')) return p.acknowledgeTermsAndConditions || 'Yes';
  if (q.includes('additional country') && !q.includes('most recently')) return (p as any).additionalCitizenship || 'No';
  if (q.includes('most recently acquired') ) return (p as any).recentCitizenshipMostRecent || 'No';
  if (q.includes('permanent residency in an additional')) return (p as any).additionalCitizenship || 'No';
  if (/^gender$/.test(q) || q.startsWith('gender?')) return (p as any).gender || 'Prefer not to say';
  if (q.includes('recruitment privacy statement') || q.includes('vibe philosophy')) return p.acknowledgeTermsAndConditions || 'Yes';
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
  initSelectOneObserver(profile);
    
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
  // After normal iterations, attempt review auto-submit
  try { await attemptAutoSubmit(); } catch(e){ console.error('[WDAF] Auto-submit error', e); }
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
  await fillOutstandingRequiredFreeText(p);
  await auditUnansweredCriticalDropdowns(p);
}

// Detect if we are on a review page (presence of a big summary and a Submit button)
function isReviewPage(): boolean {
  const submitBtn = Array.from(document.querySelectorAll('button, [role="button"], a')).find(b => /\bsubmit\b/i.test((b.textContent||'')));
  if (!submitBtn) return false;
  // Look for summary headers
  const textBlob = document.body.innerText.toLowerCase();
  const indicators = [
    'my information', 'application questions', 'voluntary disclosures'
  ];
  return indicators.every(k => textBlob.includes(k));
}

async function attemptAutoSubmit() {
  if (!isReviewPage()) { console.log('[WDAF] Not on review page, skipping auto-submit'); return; }
  console.log('[WDAF] Review page detected, validating before submit');
  // Basic validation: ensure no visible 'select one' markers or required error messages
  const unfilledDropdowns = Array.from(document.querySelectorAll('*')).some(el => (el.textContent||'').trim() === 'Select One');
  const requiredErrors = Array.from(document.querySelectorAll('*')).some(el => /required and must have a value/i.test(el.textContent||''));
  if (unfilledDropdowns || requiredErrors) {
    console.log('[WDAF] Auto-submit aborted: outstanding unfilled fields. unfilledDropdowns:', unfilledDropdowns, 'requiredErrors:', requiredErrors);
    return;
  }
  // Scroll to bottom to ensure any lazy validation attaches
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
  await sleep(400);
  const submit = Array.from(document.querySelectorAll('button, [role="button"], a')).find(b => /\bsubmit\b/i.test((b.textContent||'')));
  if (!submit) { console.log('[WDAF] Submit button not found at final stage'); return; }
  // Fire robust event sequence
  ['pointerdown','mousedown','mouseup','click'].forEach(evt => submit.dispatchEvent(new MouseEvent(evt,{bubbles:true})));
  console.log('[WDAF] Auto-submit attempted');
}

// Mutation observer to catch dynamically injected Select One dropdowns after initial pass
let __wdafObserverInitialized = false;
function initSelectOneObserver(profile: ProfileData) {
  if (__wdafObserverInitialized) return;
  __wdafObserverInitialized = true;
  try {
    const obs = new MutationObserver(async (muts) => {
      if (muts.some(m => Array.from(m.addedNodes).some(n => (n as HTMLElement)?.textContent?.includes('Select One')))) {
        console.log('[WDAF] MutationObserver detected new Select One marker');
        await handleCustomSelectOneDropdowns(profile);
        await fillOutstandingRequiredFreeText(profile);
      }
      // Watch for required error messages appearing late
      if (muts.some(m => Array.from(m.addedNodes).some(n => (n as HTMLElement)?.textContent?.match(/required and must have a value/i)))) {
        await fillOutstandingRequiredFreeText(profile);
        await auditUnansweredCriticalDropdowns(profile);
      }
    });
    obs.observe(document.body, { subtree: true, childList: true });
    // Also schedule a few delayed re-runs
    [800, 1600, 3000].forEach(ms => setTimeout(()=>{handleCustomSelectOneDropdowns(profile); fillOutstandingRequiredFreeText(profile);}, ms));
  // Later audits
  [4500, 6500, 8500, 11000].forEach(ms => setTimeout(()=>{auditUnansweredCriticalDropdowns(profile);}, ms));
  } catch(e) { console.error('[WDAF] Observer init error', e); }
}

// Fill specific required free-text questions that appear after certain answers
async function fillOutstandingRequiredFreeText(p: ProfileData) {
  try {
    // Describe Workday interactions
    const describeBlocks = Array.from(document.querySelectorAll('div,section,fieldset'))
      .filter(el => /describe your interactions with the workday system/i.test(el.textContent||''));
    for (const block of describeBlocks) {
      const ta = block.querySelector('textarea') as HTMLTextAreaElement | null;
      if (ta && !ta.value.trim()) {
        const value = (p.workdaySystemExperience && p.workdaySystemExperience.toLowerCase().startsWith('y'))
          ? 'Used Workday reporting, security groups, business process configuration; supported implementation/testing activities and regular navigation for data extraction.'
          : 'Limited direct interaction; familiar with navigation basics and reviewing tasks and reports.';
        setInputValue(ta, value);
        console.log('[WDAF] Filled Workday interactions textarea');
      }
    }

    // Provide their name, relationship, position/job title OR alternate phrasing (name, title, organization, relationship)
    const relBlocks = Array.from(document.querySelectorAll('div,section,fieldset'))
      .filter(el => /provide their name, relationship, position\/job title|provide their name, title, organization, and relationship/i.test(el.textContent||''));
    for (const block of relBlocks) {
      const input = block.querySelector('textarea, input[type="text"]') as HTMLInputElement | HTMLTextAreaElement | null;
      if (input && !(input as HTMLInputElement).value) {
        const fallback = `${(p as any).referralName || 'Jane Doe'}, ${(p as any).referralRelationship || 'Colleague'}, ${(p as any).referralTitle || 'Software Engineer'}`;
        setInputValue(input as any, fallback);
        console.log('[WDAF] Filled relationship details field');
      }
    }

    // Fallback: explicit scan for Workday interactions error anchor (when textarea not captured by describeBlocks)
    const interactionErrorEls = Array.from(document.querySelectorAll('*')).filter(el => /describe your interactions with the workday system\./i.test(el.textContent||''))
      .filter(el => /required and must have a value/i.test(el.parentElement?.textContent||''));
    for (const err of interactionErrorEls) {
      let container: HTMLElement | null = err as HTMLElement;
      for (let depth=0; depth<6 && container; depth++) {
        const ta = container.querySelector('textarea');
        if (ta) {
          if (!ta.value.trim()) {
            const value = (p.workdaySystemExperience && p.workdaySystemExperience.toLowerCase().startsWith('y'))
              ? 'Used Workday reporting, security groups, business process configuration; supported implementation/testing activities and regular navigation for data extraction.'
              : 'Limited direct interaction; familiar with navigation basics and reviewing tasks and reports.';
            setInputValue(ta, value);
            console.log('[WDAF] Fallback filled Workday interactions via error anchor');
          }
          break;
        }
        container = container.parentElement;
      }
    }

    // Generic handler: any visible error message complaining required & must have a value -> fill with placeholder
    const errorTexts = Array.from(document.querySelectorAll('*'))
      .filter(el => /required and must have a value/i.test(el.textContent||''));
    for (const errEl of errorTexts) {
      // Try to locate an input/textarea in close ancestry
      let container: HTMLElement | null = errEl.parentElement;
      for (let depth=0; depth<4 && container; depth++) {
        const field = container.querySelector('textarea, input[type="text"]') as HTMLInputElement | HTMLTextAreaElement | null;
        if (field && !(field as HTMLInputElement).value) {
          setInputValue(field as any, 'N/A');
          console.log('[WDAF] Filled generic required field with placeholder');
          break;
        }
        container = container.parentElement;
      }
    }
  } catch(e) { console.error('[WDAF] Error filling outstanding text questions', e); }
}

// Re-scan for any critical questions still showing 'Select One' and attempt again
async function auditUnansweredCriticalDropdowns(p: ProfileData) {
  try {
    const criticalPatterns: { re: RegExp; answer: string }[] = [
      { re: /authorized to work in the country/i, answer: p.workAuthorizedInCountry || 'Yes' },
      { re: /immigration filing|visa sponsorship|work permit|renewal\/extension/i, answer: p.requiresVisaSponsorship || 'No' },
      { re: /federal government|military officer/i, answer: p.federalGovernmentEmployee || 'No' },
      { re: /export control|current citizen, national or resident/i, answer: p.exportControlCountries || 'No' },
      { re: /related to a current workday employee/i, answer: p.relatedToWorkdayEmployee || 'No' },
      { re: /related to an employee of a customer|government official/i, answer: p.relatedToCustomerEmployee || 'No' },
      { re: /i acknowledge.*truthfully and accurately/i, answer: p.acknowledgeTermsAndConditions || 'Yes' }
    ];
    const selectMarkers = Array.from(document.querySelectorAll('*')).filter(el => (el.textContent||'').trim() === 'Select One');
    if (!selectMarkers.length) return;
    for (const marker of selectMarkers) {
      const q = (findQuestionForSelectOne(marker as HTMLElement) || '').toLowerCase();
      if (!q) continue;
      for (const pat of criticalPatterns) {
        if (pat.re.test(q)) {
          console.log('[WDAF] Audit retry for question:', q.slice(0,120));
          // Open clickable and choose
            const clickable = (marker as HTMLElement).closest('[data-automation-id]')?.querySelector('button, [role="button"], [role="combobox"], [aria-haspopup="listbox"], div[tabindex], span[tabindex]') as HTMLElement | null;
            if (!clickable) continue;
            ['pointerdown','mousedown','mouseup','click'].forEach(t=>clickable.dispatchEvent(new MouseEvent(t,{bubbles:true})));
            clickable.focus();
            await sleep(200);
            const opts = Array.from(document.querySelectorAll<HTMLElement>('[role="option"],[data-automation-id*="option"],li[role="option"],div[role="option"],.WDJT_option'));
            const target = pat.answer.toLowerCase();
            const match = opts.find(o=>{
              const t=(o.textContent||'').trim().toLowerCase();
              if(['yes','no'].includes(target)) { if(target==='yes') return /\byes\b/.test(t); if(target==='no') return /\bno\b/.test(t); }
              return t===target || t.startsWith(target+' ') || t.includes(target);
            }) || opts.find(o=>/\byes\b/.test(o.textContent||'')||/\bno\b/.test(o.textContent||''));
            if (match) { console.log('[WDAF] Audit choosing:', (match.textContent||'').trim()); match.click(); await sleep(120); }
            // Visa sponsorship sometimes needs keyboard confirm if click not applied
            if (/immigration filing|visa sponsorship|work permit|renewal\/extension/.test(q) && (marker as HTMLElement).textContent?.trim() === 'Select One') {
              clickable.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
              clickable.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
              await sleep(160);
              if ((marker as HTMLElement).textContent?.trim() === 'Select One') {
                const opts2 = Array.from(document.querySelectorAll<HTMLElement>('[role="option"],[data-automation-id*="option"],li[role="option"],div[role="option"],.WDJT_option'));
                const noOpt = opts2.find(o => /(^|\b)no(\b|$)/i.test((o.textContent||'')));
                if (noOpt) { ['pointerdown','mousedown','mouseup','click'].forEach(t=>noOpt.dispatchEvent(new MouseEvent(t,{bubbles:true}))); }
                await sleep(140);
              }
            }
        }
      }
    }
    // Relationship details fallback if appears after relation answers
    const relAltBlocks = Array.from(document.querySelectorAll('div,section,fieldset'))
      .filter(el => /provide their name, title, organization, and relationship/i.test(el.textContent||''));
    for (const block of relAltBlocks) {
      const field = block.querySelector('textarea, input[type="text"]') as HTMLInputElement | HTMLTextAreaElement | null;
      if (field && !(field as HTMLInputElement).value) {
        const fallback = `${(p as any).referralName || 'Jane Doe'}, ${(p as any).referralRelationship || 'Colleague'}, ${(p as any).referralTitle || 'Software Engineer'}, Workday acquaintance`;
        setInputValue(field as any, fallback);
        console.log('[WDAF] Audit filled relationship details field (alternate phrasing)');
      }
    }
  } catch(e) { console.error('[WDAF] Audit error', e); }
}

async function fillByLabels(p: ProfileData) {
  console.log("[WDAF] Starting fillByLabels with profile:", p);
  const inputs = Array.from(document.querySelectorAll("input, textarea, select")) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  console.log("[WDAF] Found", inputs.length, "form inputs");
  // Ensure observer for dynamically loaded dropdowns is active
  initSelectOneObserver(p);
  
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
        // Specialized handling: Workday system interaction description
        const block = (label || '').toLowerCase();
        let questionContext = block;
        if (!questionContext || questionContext.length < 10) {
          // try to derive from nearby text
          const ctx = el.closest('div,section,fieldset');
            if (ctx) {
              const txt = (ctx.textContent||'').toLowerCase();
              if (txt.includes('describe your interactions with the workday system')) questionContext = txt;
            }
        }
        if (/describe your interactions with the workday system/.test(questionContext)) {
          value = p.workdaySystemExperience && p.workdaySystemExperience.toLowerCase() === 'yes'
            ? "Used Workday reporting, security groups, business process configuration and assisted in tenant setup; regular navigation for data extraction and testing."
            : "Limited direct interaction; familiar with navigation basics and candidate/application tracking views.";
        } else {
          value = "Auto-filled via extension. Will provide details upon request.";
        }
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
