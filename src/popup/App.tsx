import React, { useEffect, useState } from "react";
import { loadData, saveData, clearData } from "@shared/storage";
import { inferSummary } from "@shared/mapping";

type FormData = Record<string, any>;

export default function App() {
  const [jsonText, setJsonText] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [summary, setSummary] = useState<string>("");
  const [autofillOnLoad, setAutofillOnLoad] = useState<boolean>(true);

  useEffect(() => {
    (async () => {
      const data = await loadData();
      if (data) {
        setJsonText(JSON.stringify(data, null, 2));
        setSummary(inferSummary(data));
      }
      const flag = (await chrome.storage.local.get("autofillOnLoad")).autofillOnLoad ?? true;
      setAutofillOnLoad(flag);
    })();
  }, []);

  const handleLoad = async () => {
    try {
      const obj = JSON.parse(jsonText);
      await saveData(obj);
      setSummary(inferSummary(obj));
      setStatus("Saved ✓");
      setTimeout(()=>setStatus(""), 1500);
    } catch (e:any) {
      setStatus("Invalid JSON: " + e.message);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setJsonText(text);
  };

  const handleStart = async () => {
    setStatus("Starting autofill…");
    await chrome.storage.local.set({ autofillOnLoad });
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setStatus("No active tab found");
        return;
      }
      
      console.log('Sending message to tab:', tab.id, 'URL:', tab.url);
      
      // Try to inject content script first (in case it's not already loaded)
      try {
        console.log('Pre-injecting content script...');
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        console.log('Content script injected successfully');
      } catch (injectionError: any) {
        console.log('Pre-injection failed (script may already be loaded):', injectionError.message);
        // Continue anyway - script might already be loaded
      }
      
      // Wait a moment for script to initialize
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Now try to send the message
      try {
        setStatus("Sending autofill command...");
        const response = await chrome.tabs.sendMessage(tab.id, { type: "START_AUTOFILL" });
        console.log('Response from content script:', response);
        
        if (response?.success === false) {
          setStatus("Error: " + (response.error || "Content script error"));
          setTimeout(() => setStatus(""), 3000);
          return;
        }
        
        setStatus("Autofill triggered ✓");
        setTimeout(() => setStatus(""), 1500);
        return;
      } catch (messageError: any) {
        console.error('Message sending failed:', messageError);
        setStatus(`Communication failed: ${messageError.message}`);
        setTimeout(() => setStatus(""), 5000);
        return;
      }
      
    } catch (error: any) {
      console.error("General error:", error);
      setStatus("Error: " + error.message);
      setTimeout(() => setStatus(""), 5000);
    }
  };

  const handleClear = async () => {
    await clearData();
    setJsonText("");
    setSummary("");
    setStatus("Cleared ✓");
    setTimeout(()=>setStatus(""), 1500);
  };

  return (
    <div style={{ padding: "1rem", width: "360px", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: "1.2rem", margin: "0 0 1rem" }}>Workday Auto-Fill</h1>
      
      <p style={{ fontSize: "0.9rem", color: "#666", margin: "0 0 1rem" }}>
        Load your JSON, then click Start on a Workday application page.
      </p>

      <div style={{ marginBottom: "1rem", padding: "1rem", border: "1px solid #ddd", borderRadius: "4px" }}>
        <label style={{ display: "block", fontWeight: "bold", marginBottom: "0.5rem" }}>JSON File</label>
        <input type="file" accept=".json" onChange={handleFile} style={{ width: "100%" }} />
      </div>

      <div style={{ marginBottom: "1rem", padding: "1rem", border: "1px solid #ddd", borderRadius: "4px" }}>
        <label style={{ display: "block", fontWeight: "bold", marginBottom: "0.5rem" }}>JSON Text</label>
        <textarea 
          value={jsonText} 
          onChange={e=>setJsonText(e.target.value)} 
          placeholder="{ ... }" 
          rows={10} 
          style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
        />
        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
          <button onClick={handleLoad} style={{ padding: "0.5rem 1rem", backgroundColor: "#007cba", color: "white", border: "none", borderRadius: "4px" }}>
            Save JSON
          </button>
          <button onClick={handleClear} style={{ padding: "0.5rem 1rem", backgroundColor: "#999", color: "white", border: "none", borderRadius: "4px" }}>
            Clear
          </button>
        </div>
      </div>

      <div style={{ marginBottom: "1rem", padding: "1rem", border: "1px solid #ddd", borderRadius: "4px" }}>
        <label style={{ display: "flex", alignItems: "center", marginBottom: "0.5rem" }}>
          <input 
            type="checkbox" 
            checked={autofillOnLoad} 
            onChange={e=>setAutofillOnLoad(e.target.checked)}
            style={{ marginRight: "0.5rem" }}
          />
          Auto-continue through steps
        </label>
        <button 
          onClick={handleStart} 
          style={{ 
            width: "100%", 
            padding: "0.75rem", 
            backgroundColor: "#28a745", 
            color: "white", 
            border: "none", 
            borderRadius: "4px", 
            fontSize: "1rem",
            fontWeight: "bold"
          }}
        >
          Start Autofill
        </button>
      </div>

      {summary && (
        <div style={{ marginBottom: "1rem", padding: "1rem", border: "1px solid #ddd", borderRadius: "4px" }}>
          <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>Summary</div>
          <pre style={{ fontSize: "0.8rem", margin: 0, whiteSpace: "pre-wrap" }}>{summary}</pre>
        </div>
      )}

      {status && (
        <div style={{ 
          padding: "0.5rem", 
          backgroundColor: status.includes("✓") ? "#d4edda" : "#f8d7da", 
          color: status.includes("✓") ? "#155724" : "#721c24",
          borderRadius: "4px",
          fontSize: "0.9rem",
          marginBottom: "1rem"
        }}>
          {status}
        </div>
      )}

      <div style={{ fontSize: "0.8rem", color: "#999", textAlign: "center" }}>
        v1.0 • React + TS • MV3
      </div>
    </div>
  );
}
