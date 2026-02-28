import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ToolMode } from '../core/types';

export type InteractionMode = 'edit' | 'camera';

interface GridPoint {
  x: number;
  y: number;
}

export interface InputControllerOptions {
  domElement: HTMLElement;
  camera: THREE.Camera;
  terrainMesh: THREE.Object3D;
  controls: OrbitControls;
  worldSize: number;
  onHover: (x: number, y: number) => void;
  getInteractionMode: () => InteractionMode;
  getPhotoMode: () => boolean;
  onPaint: (x: number, y: number, isInitialStroke: boolean, shiftKey: boolean) => void;
  onToolKey: (tool: ToolMode) => void;
  onInteractionModeKey: (mode: InteractionMode) => void;
  onDebugModeToggleKey: () => void;
  onPhotoModeToggleKey: () => void;
  onRiverGuideToggleKey: () => void;
  onPhotoFovDeltaKey: (delta: number) => void;
  onPhotoDofDeltaKey: (delta: number) => void;
  onPhotoCaptureKey: () => void;
  onRadiusDelta: (delta: number) => void;
}

export class InputController {
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly terrainMesh: THREE.Object3D;
  private readonly controls: OrbitControls;
  private readonly worldSize: number;
  private readonly onHover: (x: number, y: number) => void;
  private readonly getInteractionMode: () => InteractionMode;
  private readonly getPhotoMode: () => boolean;
  private readonly onPaint: (
    x: number,
    y: number,
    isInitialStroke: boolean,
    shiftKey: boolean
  ) => void;
  private readonly onToolKey: (tool: ToolMode) => void;
  private readonly onInteractionModeKey: (mode: InteractionMode) => void;
  private readonly onDebugModeToggleKey: () => void;
  private readonly onPhotoModeToggleKey: () => void;
  private readonly onRiverGuideToggleKey: () => void;
  private readonly onPhotoFovDeltaKey: (delta: number) => void;
  private readonly onPhotoDofDeltaKey: (delta: number) => void;
  private readonly onPhotoCaptureKey: () => void;
  private readonly onRadiusDelta: (delta: number) => void;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private isPainting = false;

  private readonly onPointerDownBound: (event: PointerEvent) => void;
  private readonly onPointerMoveBound: (event: PointerEvent) => void;
  private readonly onPointerUpBound: (event: PointerEvent) => void;
  private readonly onKeyDownBound: (event: KeyboardEvent) => void;
  private readonly onContextMenuBound: (event: MouseEvent) => void;

  constructor(options: InputControllerOptions) {
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.terrainMesh = options.terrainMesh;
    this.controls = options.controls;
    this.worldSize = options.worldSize;
    this.onHover = options.onHover;
    this.getInteractionMode = options.getInteractionMode;
    this.getPhotoMode = options.getPhotoMode;
    this.onPaint = options.onPaint;
    this.onToolKey = options.onToolKey;
    this.onInteractionModeKey = options.onInteractionModeKey;
    this.onDebugModeToggleKey = options.onDebugModeToggleKey;
    this.onPhotoModeToggleKey = options.onPhotoModeToggleKey;
    this.onRiverGuideToggleKey = options.onRiverGuideToggleKey;
    this.onPhotoFovDeltaKey = options.onPhotoFovDeltaKey;
    this.onPhotoDofDeltaKey = options.onPhotoDofDeltaKey;
    this.onPhotoCaptureKey = options.onPhotoCaptureKey;
    this.onRadiusDelta = options.onRadiusDelta;

    this.onPointerDownBound = this.onPointerDown.bind(this);
    this.onPointerMoveBound = this.onPointerMove.bind(this);
    this.onPointerUpBound = this.onPointerUp.bind(this);
    this.onKeyDownBound = this.onKeyDown.bind(this);
    this.onContextMenuBound = this.onContextMenu.bind(this);

    this.domElement.addEventListener('pointerdown', this.onPointerDownBound);
    this.domElement.addEventListener('pointermove', this.onPointerMoveBound);
    window.addEventListener('pointerup', this.onPointerUpBound);
    window.addEventListener('keydown', this.onKeyDownBound);
    this.domElement.addEventListener('contextmenu', this.onContextMenuBound);
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDownBound);
    this.domElement.removeEventListener('pointermove', this.onPointerMoveBound);
    window.removeEventListener('pointerup', this.onPointerUpBound);
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.domElement.removeEventListener('contextmenu', this.onContextMenuBound);
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    if (this.getInteractionMode() === 'camera') {
      return;
    }

    this.isPainting = true;
    this.controls.enabled = false;
    this.domElement.setPointerCapture(event.pointerId);
    this.tryPaint(event, true);
  }

  private onPointerMove(event: PointerEvent): void {
    const point = this.screenToGrid(event);
    if (point) {
      this.onHover(point.x, point.y);
    }

    if (!this.isPainting) {
      return;
    }

    if (point) {
      this.onPaint(point.x, point.y, false, event.shiftKey);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.button !== 0 || !this.isPainting) {
      return;
    }

    this.isPainting = false;
    this.controls.enabled = true;
    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }
  }

  private onContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }

    // Preserve browser/system shortcuts like Ctrl+R / Cmd+R.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (event.key === 'p' || event.key === 'P') {
      this.onPhotoModeToggleKey();
      event.preventDefault();
      return;
    }

    if (event.key === 'r' || event.key === 'R') {
      this.onRiverGuideToggleKey();
      event.preventDefault();
      return;
    }

    const inPhotoMode = this.getPhotoMode();
    if (inPhotoMode) {
      if (event.key === 'Escape') {
        this.onPhotoModeToggleKey();
        event.preventDefault();
      } else if (event.key === '[') {
        this.onPhotoFovDeltaKey(-1);
        event.preventDefault();
      } else if (event.key === ']') {
        this.onPhotoFovDeltaKey(1);
        event.preventDefault();
      } else if (event.key === '-' || event.key === '_') {
        this.onPhotoDofDeltaKey(-0.05);
        event.preventDefault();
      } else if (event.key === '=' || event.key === '+') {
        this.onPhotoDofDeltaKey(0.05);
        event.preventDefault();
      } else if (event.key === 'k' || event.key === 'K') {
        this.onPhotoCaptureKey();
        event.preventDefault();
      }
      return;
    }

    if (event.key === '1') {
      this.onToolKey('raise');
    } else if (event.key === '2') {
      this.onToolKey('lower');
    } else if (event.key === '3') {
      this.onToolKey('flatten');
    } else if (event.key === '4') {
      this.onToolKey('waterSource');
    } else if (event.key === '0') {
      this.onInteractionModeKey('camera');
    } else if (event.key === '[') {
      this.onRadiusDelta(-1);
      event.preventDefault();
    } else if (event.key === ']') {
      this.onRadiusDelta(1);
      event.preventDefault();
    } else if (event.key === 'd' || event.key === 'D') {
      this.onDebugModeToggleKey();
      event.preventDefault();
    }
  }

  private tryPaint(event: PointerEvent, isInitialStroke: boolean): void {
    const point = this.screenToGrid(event);
    if (!point) {
      return;
    }

    this.onPaint(point.x, point.y, isInitialStroke, event.shiftKey);
  }

  private screenToGrid(event: PointerEvent): GridPoint | null {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    this.ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.ndc, this.camera);
    const intersections = this.raycaster.intersectObject(this.terrainMesh, false);
    if (intersections.length === 0) {
      return null;
    }

    const point = intersections[0]?.point;
    if (!point) {
      return null;
    }

    const half = (this.worldSize - 1) * 0.5;
    const x = Math.round(point.x + half);
    const y = Math.round(point.z + half);

    if (x < 0 || x >= this.worldSize || y < 0 || y >= this.worldSize) {
      return null;
    }

    return { x, y };
  }
}
