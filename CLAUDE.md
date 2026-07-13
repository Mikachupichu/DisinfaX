# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview
The project is a browser extension built using WXT and React. The core logic resides within the `entrypoints/popup` directory, which contains the main application components (`App.tsx`, `main.tsx`) and associated styling.

## Development Commands
- **Build:** To build the project for distribution: `npm run build` (or equivalent command from `package.json`).
- **Lint:** To check code quality: `npm run lint`.
- **Run Tests:** To run all tests: `npm test`.
- **Single Test:** To run a specific test file or component, consult the testing framework documentation, but typically this is done via `npm test -- <test_file>`.

## Project Structure Notes
- The application entry point for the popup is located at `entrypoints/popup/main.tsx`.
- Configuration for WXT is in `wxt.config.ts`.
- Styling is managed through CSS files within the popup entrypoint directory (`App.css`, `style.css`).

## External Rules
No specific Cursor or Copilot rules were found in `.cursor/rules/` or `.github/copilot-instructions.md`.