# Hakoniwa

A browser-based sandbox prototype focused on three core loops:

- Terrain editing (raise/lower/flatten)
- Height-field water simulation
- Atmosphere + vegetation for scenic viewing

This project uses **Web + Three.js + TypeScript** and targets desktop browsers.

## Live Demo

- Production: `https://yatabis.github.io/hakoniwa/`

## Current MVP Scope

Implemented:

- Fixed world size: `128 x 128` grid
- Procedural terrain generation with seed support
- Terrain brush tools with radius/strength
- Water source placement/removal
- Height-field water simulation
  - source injection
  - downhill flow
  - damping / evaporation / seepage / edge drain
- Climate system
  - simulated day-night cycle (24-minute full cycle, starts at 07:00)
  - cloud/rain simulation
- Photo mode
  - HUD hide for scenic viewing
  - FOV and DOF-style post effect controls
  - PNG screenshot capture
- River guide overlay
  - terrain-derived downhill flow path hints
- Debug overrides
  - day cycle override (simulation/manual hour)
  - weather override (simulation/manual cloud/rain)
- Vegetation placement based on altitude, slope, water, and humidity
- IndexedDB save/load (3 slots)
- Unit tests + one E2E flow test

Out of scope (for now):

- Multiplayer
- Mobile UX optimization
- Sharing/export features

## Tech Stack

- Runtime: `three`
- App: `vite`, `typescript`
- Quality: `eslint`, `prettier`
- Unit tests: `vitest`
- E2E tests: `playwright`

## Setup

Requirements:

- Node.js 20+
- pnpm

Install and run:

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:4173`.

## Scripts

```bash
pnpm dev           # start dev server
pnpm build         # typecheck + production build
pnpm preview       # preview production build
pnpm lint          # eslint (warnings are treated as errors)
pnpm typecheck     # tsc --noEmit
pnpm format        # prettier --write
pnpm format:check  # prettier --check
pnpm test          # vitest run
pnpm test:e2e      # playwright test
```

## Deploy (GitHub Pages)

This repository includes a workflow at `.github/workflows/deploy-pages.yml`.

One-time setup on GitHub:

1. Open your repository settings.
2. Go to **Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main` (or run the workflow manually).

Manual optional E2E run:

1. Open **Actions** > **Deploy to GitHub Pages**.
2. Click **Run workflow**.
3. Enable `run_e2e`.
4. Run it manually to execute Playwright E2E in CI.

How base path is handled:

- On local dev/build: `base = /`
- On GitHub Actions:
  - user/org pages repo (`<name>.github.io`): `base = /`
  - project pages repo (`<repo>`): `base = /<repo>/`

Optional override:

- Set repository variable `VITE_BASE_PATH` (example: `/hakoniwa/` or `/`) when you need a custom base path (for example, custom domain/subpath setups).

## Controls

### Keyboard

- `1`: Raise tool
- `2`: Lower tool
- `3`: Flatten tool
- `4`: Water Source tool
- `0`: Camera mode
- `[` / `]`: Brush radius down/up
- `P`: Toggle photo mode
- `R`: Toggle river guide overlay
- `D`: Toggle debug mode

Photo mode shortcuts:

- `[` / `]`: FOV down/up
- `-` / `=`: DOF strength down/up
- `K`: Capture PNG screenshot
- `Esc` or `P`: Exit photo mode

### Mouse

In edit mode:

- Left drag: apply current tool
- Right drag: camera rotate

In camera mode:

- Left drag: camera pan
- Right drag: camera rotate
- Wheel: zoom

## UI Overview

Main panel includes:

- Tool buttons (0 Camera, 1-4 Edit tools)
- Brush controls (contextual): Radius, Strength, Flatten target, Source rate
- Save/Load buttons for slots 1..3
- Status line
- Photo mode (HUD hidden for scenic view, with subtle DOF post effect and screenshot capture)
- River guide overlay toggle (terrain-derived flow path candidates)

Debug-only panels:

- Day Cycle (Debug)
  - `Simulation (24m cycle)`
  - `Manual Override` + Hour slider (`0..24`)
- Weather (Debug)
  - `Simulation`
  - `Manual Override` + Cloud slider (`0..1`) + Rain slider (`0..1`)
- Terrain Seed display (read-only)

When debug mode is turned off, day cycle and weather modes automatically return to default (`simulation` / `simulation`).

## Simulation Details

### Terrain Editing

- Circular brush with linear falloff
- Influence:

```text
influence = (1 - distance / radius) * strength
```

- Tool effects:
  - Raise: `h += influence`
  - Lower: `h -= influence`
  - Flatten: `h += (target - h) * influence`
- Terrain height is clamped to `[-12, 24]`

### Water Simulation

Per simulation step (`stepWater`):

1. Inject active sources: `water[sourceCell] += rate * dt`
2. Compute potential outflow to 4 neighbors from total height differences
3. Scale outflow so it never exceeds local available water
4. Apply losses:
   - damping
   - evaporation
   - seepage
   - edge drain (border cells)
5. Clamp negative water to zero

Default parameters:

- `dt = 1 / 60`
- `flowRate = 1.8`
- `damping = 0.025`
- `evaporation = 0.0003`
- `seepage = 0.04`
- `edgeDrain = 0.3`

### Climate + Rain

- Day phase from simulation time by default
- 24 minutes = 1 full day cycle, starting at 07:00 when world time is 0
- Daylight drives atmosphere and part of vegetation vitality
- Cloud/rain are procedural signals based on world simulation time and terrain seed
- Rain adds water each step with altitude-based orographic bias

### Humidity + Vegetation

- Humidity map updates every sim step from water/rain/altitude
- Periodic humidity diffusion across 4-neighborhood
- Vegetation placement constraints include:
  - altitude range
  - low-to-moderate slope
  - low standing water
  - minimum humidity
- Rendered as `InstancedMesh` for performance (`MAX_VEGETATION = 20000`)

## Rendering Notes

- Low-poly terrain with height-based vertex colors
- Custom water shader:
  - flow direction and strength from height gradients
  - animated ripples, foam, turbidity, fresnel
  - weather/daylight-dependent appearance
- Atmosphere updates each frame:
  - sky color
  - fog color and range
  - directional + hemisphere lighting
  - tone mapping exposure

## Persistence

- IndexedDB database: `hakoniwa-worlds`
- Store: `slots`
- Save format includes:
  - terrain seed
  - terrain heights
  - water heights
  - water sources
  - vegetation seed
  - world time

## Tests and Quality Gates

Unit tests cover:

- Terrain brush behavior
- Water mass/flow behavior
- World generation determinism and bounds
- Persistence round-trip

E2E test covers:

- Edit terrain
- Place source
- Save slot
- Reload page
- Load slot

Recommended completion gate:

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
```

## Project Structure

```text
src/
  core/         # grid, world generation, terrain tools, water simulation
  render/       # three.js scene, water shader, vegetation rendering
  input/        # pointer/keyboard controller
  ui/           # HUD and controls
  persistence/  # IndexedDB save/load and serialization
  main.ts       # app wiring + simulation loop
  style.css     # UI styling

tests/          # vitest unit tests
e2e/            # playwright tests
```

## Known Constraints

- Single fixed grid resolution (`128x128`)
- No undo/redo history yet
- No save slot metadata UI (only status messages)
- No cross-device cloud sync
