# Workday Autofill Extension

A Chrome extension that automatically fills out Workday job application forms using saved profile data.

## Features

- 🚀 **Auto-fill personal information** (name, email, phone, address)
- 💼 **Work experience management** - automatically adds and fills work history
- 🎓 **Education experience** - handles education background
- 📋 **Project experience** - fills in project details
- ⚡ **Smart form detection** - works across different Workday implementations
- 🔄 **Multi-page support** - continues through application steps
- 💾 **Profile data storage** - save your information once, use everywhere

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone https://github.com/MedaSivaManoj/workday-autofill-extension.git
   cd workday-autofill-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run build
   ```

4. Load in Chrome:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `dist` folder

## Usage

1. **Set up your profile**: Click the extension icon and fill in your personal information
2. **Navigate to a Workday job application**: Go to any company's Workday careers page
3. **Start autofill**: Click the extension icon and hit "Start Autofill"
4. **Watch it work**: The extension will automatically fill forms and navigate through steps

## Supported Sites

- All Workday-powered career sites (myworkdayjobs.com, workday.com)
- Custom Workday implementations

## Profile Data

The extension uses a JSON profile format. See `example.json` for the complete structure including:

- Personal information (name, contact details)
- Work experiences with dates and descriptions
- Education background
- Project portfolio
- Work authorization status

## Development

```bash
# Install dependencies
npm install

# Development build with watch
npm run dev

# Production build
npm run build

# Preview build
npm run preview
```

## Technology Stack

- **Frontend**: React 18 + TypeScript
- **Build Tool**: Vite
- **Extension**: Chrome Extension Manifest V3
- **Storage**: Chrome Storage API

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License.

## Disclaimer

This extension is for educational and personal use. Always review and verify information before submitting job applications. Respect website terms of service and use responsibly.

## Features
- React + TypeScript popup to load/edit JSON
- Content script that detects Workday steps and fills fields via label/placeholder/ARIA
- Handles multi-entry sections for Work Experience, Education, Projects
- Auto-continue through steps (configurable)
- Safe random fallbacks for missing values
- MV3 service worker setup, Vite build with deterministic file names

## Install (Developer Mode)
1. `pnpm install` or `npm install` or `yarn`
2. `pnpm build` (or `npm run build`)
3. In Chrome: `chrome://extensions` → Enable *Developer mode* → **Load unpacked** → select the `dist/` folder.

## Usage
1. Open any Workday job application (e.g., `*.myworkdayjobs.com`). Go to **Sign In / Create Account** or **Apply**.
2. Click the extension icon → Load your JSON via file or paste into the textbox → **Save JSON**.
3. Check **Auto-continue through steps** if you want automatic navigation.
4. Click **Start Autofill** while on the application tab.
5. The extension fills each step and tries to hit **Continue / Save and Continue / Next** up to several times.

> Tip: If a site uses unusual custom fields, the label-heuristic may not find a match. You can still proceed and manually fill remaining bits.

## JSON Shape
See `example.json` below—this is the structure the extension expects. Missing fields will be replaced with reasonable random values.

## Record the Demo
- Open a screen recorder (e.g., OBS or Chrome's built-in recorder).
- Start on the **Sign In / Create Account** page of a Workday posting.
- Click the extension → **Start Autofill**.
- Record the extension filling **My Information → My Experience → Application Questions → Voluntary Disclosures → Review**.
- Stop recording at the **Review** page.

## Notes & Limits
- Workday UIs vary by company and configuration. This extension uses robust heuristics but cannot guarantee 100% coverage for every custom field.
- Please respect terms of service of the target site(s). Use for personal application convenience only.

## Dev
- Popup is at `src/popup/*`.
- Content script at `src/content/content.ts`.
- Shared helpers in `src/shared/*`.
- Build produces: `dist/popup/index.html`, `dist/content.js`, `dist/background.js`, and copies `manifest.json` + `icons`.

