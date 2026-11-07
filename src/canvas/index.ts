// 入口：本部公开 API（契约类型从 ./contract 引入）
// 第三部集成时从这里取用画布能力；浏览器演示入口在 ./main.ts

export * from './contract.js';

// 几何
export { GRID, snapScalar, snapPos, snapDown, isOnGrid } from './geometry/grid.js';
export type { Rect, Dir } from './geometry/types.js';
export { DIR_VEC, dirReverse, rectFromPoints, normalizeRect, midOf } from './geometry/types.js';
export {
  pointInRect,
  rectsIntersect,
  rectContainsRect,
  pointSegmentDistance,
  pointPolylineDistance,
  polylineHit,
  pointInCircle,
  polylineBounds,
} from './geometry/hit.js';
export {
  STUB,
  stubEnd,
  orthoMid,
  orthoViaWaypoint,
  routeOrthogonal,
  simplifyPolyline,
  polylineLength,
  isOrthogonal,
} from './geometry/route.js';
export {
  ZOOM_MIN,
  ZOOM_MAX,
  clampZoom,
  panForZoomAt,
  worldToScreen,
  screenToWorld,
} from './geometry/view.js';
export { wirePolyline, allWirePolylines, portKey } from './geometry/wirepath.js';

// 模型（形状注册表）
export {
  registerShape,
  getShape,
  genericShape,
  listShapeKinds,
  componentBoundsOf,
  componentPixelSize,
  portPos,
  portsOf,
  portStubDir,
  sideToDir,
} from './model/shapes.js';
export type { ShapeDef, ShapePort, PortSide } from './model/shapes.js';

// 渲染
export type { RenderContext, TextMetrics } from './render/RenderContext.js';
export { RecorderContext } from './render/RecorderContext.js';
export type { RecordedCall } from './render/RecorderContext.js';
export { CanvasAdapter } from './render/CanvasAdapter.js';
export { COLORS, valueColor } from './render/colors.js';
export { drawComponentBodyAt } from './render/shapesDraw.js';
export { drawScene, drawGrid, drawWires, drawComponents, drawDiagnostics, drawOverlay } from './render/renderer.js';
export { emptyScene, projectDiagnostics } from './render/scene.js';
export type { Scene, ViewState, CanvasOverlay, DiagnosticVisuals, ValueTable } from './render/scene.js';

// 交互
export { transition, initialFsmState, DRAG_THRESHOLD } from './interact/fsm.js';
export type {
  FsmState,
  FsmEvent,
  FsmAction,
  FsmQuery,
  HitPort,
  MouseButton,
  TransitionResult,
} from './interact/fsm.js';

// 状态
export {
  nextComponentId,
  nextWireId,
  addComponent,
  moveComponents,
  deleteIds,
  addWire,
  setProps,
  patchProps,
  applyPreviewDelta,
  samePortRef,
} from './state/edits.js';
export type { AddComponentResult, AddWireResult } from './state/edits.js';
export { History } from './state/history.js';
export { NetlistDoc } from './state/doc.js';
export type { DocListener } from './state/doc.js';
export {
  EMPTY_SELECTION,
  isEmptySelection,
  selectionCount,
  makeSelection,
  toggleInSelection,
  unionSelection,
  pruneSelection,
  clearSelection,
} from './state/selection.js';
export type { Selection } from './state/selection.js';
export {
  copySelection,
  pasteData,
  toClipboardText,
  fromClipboardText,
} from './state/clipboard.js';
export type { ClipboardData, PasteResult } from './state/clipboard.js';

// 仿真
export { MockEngine } from './mock/MockEngine.js';
export { SimController, RUN_BASE_HZ } from './sim/SimController.js';
export type { SpeedFactor } from './sim/SimController.js';

// 存档
export { serializeNetlist, parseNetlist, roundTripEqual, ARCHIVE_EXT } from './io/serialize.js';
export type { ParseResult } from './io/serialize.js';
export {
  downloadNetlist,
  uploadNetlist,
  saveLocal,
  loadLocal,
  clearLocal,
  browserDownloadEnv,
  browserUploadEnv,
  browserStorage,
  LS_KEY,
} from './io/fileio.js';
export type { DownloadEnv, UploadEnv, KeyValueStorage, UploadResult } from './io/fileio.js';

// UI（浏览器环境用）
export { CanvasView } from './ui/CanvasView.js';
export type { CanvasViewCallbacks, PointerEventInfo } from './ui/CanvasView.js';
export { Controller, SELECT_TOOL } from './ui/Controller.js';
export type { ControllerHooks } from './ui/Controller.js';
