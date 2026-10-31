type ToolColor = { r: number; g: number; b: number; a: number }
type Placement = "auto" | "up" | "down" | "left" | "right"
type EndpointStyle = "slash" | "line-arrow" | "arrow"
interface DimensionSides { widthSide: 'top' | 'bottom'; heightSide: 'left' | 'right' }
type Params = { units: "mm" | "cm" | "m" | "in" | "ft"; scale: number; decimals: number; offset: number; labelOffset: number; strokeWeight: number; fontSize: number; fontFamily: string; fontColor: ToolColor; lineColor: ToolColor; showWidth: boolean; showHeight: boolean; placement: Placement; endpointStyle: EndpointStyle }
type RunMsg =
  | { type: 'action'; id: string; params: Partial<Params> }
  | { type: 'params-update'; params: Partial<Params> }
  | { type: 'resize'; height: number }
  | { type: 'reset-defaults' }
  | { type: 'reset-appearance' }
const TOOL_ID = "e9f699d4-0a4e-4849-9f6e-400e237cb467"
const DISPLAY_NAME = "Dimnote"
const ATTACH_KEY = TOOL_ID + ':state'
const DIM_DATA_KEY = TOOL_ID + ':dim'
const DIM_TARGET_KEY = TOOL_ID + ':target'  // stores the target node ID on each dim frame
const ANNOTATION_STATE_KEY = TOOL_ID + ':annotation'
const DOC_PARAMS_KEY = TOOL_ID + ':doc-params'  // document-level saved params
const SELECTION_BADGE_KEY = TOOL_ID + ':selection-badge'
const SELECTION_BADGE_FONT: FontName = { family: 'Inter', style: 'Medium' }
const DEFAULTS: Params = { units: "mm", scale: 1, decimals: 1, offset: 30, labelOffset: 10, strokeWeight: 1, fontSize: 14, fontFamily: "Roboto Mono", fontColor: {"r":0.6,"g":0.6,"b":0.6,"a":1}, lineColor: {"r":0.6,"g":0.6,"b":0.6,"a":1}, showWidth: true, showHeight: true, placement: "auto", endpointStyle: "slash" }
let latestParams: Params = DEFAULTS
let isExecuting = false
let selectionBadge: FrameNode | null = null
let selectionBadgeTarget: SceneNode | null = null
let selectionBadgeRevision = 0
let selectionBadgeUpdateTimer: number | null = null
let selectionBadgeZoomTimer: number | null = null
let lastSelectionBadgeZoom = 1
let selectionBadgeScale = 1
let selectionBadgeLabel = ''
let selectionBadgeSelectedId = ''
let selectionBadgePending: { revision: number; page: PageNode; selectedId: string; targetId: string } | null = null
const selectionBadgePages = new Set<PageNode>()
let pluginClosed = false
let autoRefreshPage: PageNode | null = null

/** Save current params to the document root so they persist across selection changes. */
function saveDocParams(params: Params): void {
  try { figma.root.setPluginData(DOC_PARAMS_KEY, JSON.stringify(params)) } catch (_) {}
}

/** Load params saved to the document root, or return DEFAULTS if none saved. */
function loadDocParams(): Params {
  try {
    const raw = figma.root.getPluginData(DOC_PARAMS_KEY)
    if (raw) return normalizeParams(JSON.parse(raw))
  } catch (_) {}
  return { ...DEFAULTS }
}

// ── Dimension metadata ────────────────────────────────────────────────

type DimensionSide = 'top' | 'bottom' | 'left' | 'right'

interface DimMeta {
  mode?: 'linked' | 'freeform'
  axis: 'h' | 'v' | 'a' | 'r'
  side?: DimensionSide
  scale: number
  units: string
  decimals: number
  localX?: number
  localY?: number
  radiusParams?: Params
  measuredSpan?: number
  gapPair?: string[]
  gapExtensions?: number[]
  perimeterEdge?: string
  clearanceExtra?: number
  edgeLinear?: boolean
}

interface Point2 { x: number; y: number }
interface AngledEdge { start: Point2; end: Point2; length: number; insidePoint?: Point2; key?: string }

function formatMeasurement(value: number, decimals: number): string {
  return Number(value.toFixed(decimals)).toString()
}

function formatDimValue(px: number, meta: DimMeta): string {
  const val = px * meta.scale
  // Keep the measurement and unit together when a label is constrained or rotated.
  return (meta.axis === 'r' ? 'R' : '') + formatMeasurement(val, meta.decimals) + '\u00A0' + meta.units
}

// ── Utility helpers ───────────────────────────────────────────────────

function finiteNumber(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeColor(value: unknown, fallback: ToolColor): ToolColor {
  if (typeof value !== 'object' || value === null) return fallback
  const obj = value as Partial<ToolColor>
  return {
    r: clamp(finiteNumber(obj.r, fallback.r), 0, 1),
    g: clamp(finiteNumber(obj.g, fallback.g), 0, 1),
    b: clamp(finiteNumber(obj.b, fallback.b), 0, 1),
    a: clamp(finiteNumber(obj.a, fallback.a), 0, 1),
  }
}

const VALID_PLACEMENTS: Placement[] = ["auto", "up", "down", "left", "right"]

function normalizeParams(input: Partial<Params> | null | undefined): Params {
  const value = input ?? {}
  return {
    units: ["mm","cm","m","in","ft"].includes(String(value.units)) ? (String(value.units) as Params['units']) : DEFAULTS.units,
    scale: clamp(finiteNumber(value.scale, DEFAULTS.scale), 0.001, 10000),
    decimals: clamp(finiteNumber(value.decimals, DEFAULTS.decimals), 0, 4),
    offset: clamp(finiteNumber(value.offset, DEFAULTS.offset), 12, 80),
    labelOffset: clamp(finiteNumber(value.labelOffset, DEFAULTS.labelOffset), 6, 30),
    strokeWeight: clamp(finiteNumber(value.strokeWeight, DEFAULTS.strokeWeight), 0.25, 5),
    fontSize: clamp(finiteNumber(value.fontSize, DEFAULTS.fontSize), 6, 32),
    fontFamily: typeof value.fontFamily === 'string' && value.fontFamily.trim().length > 0 ? value.fontFamily.trim() : DEFAULTS.fontFamily,
    fontColor: normalizeColor(value.fontColor ?? (value as Record<string, unknown>).color as ToolColor | undefined, DEFAULTS.fontColor),
    lineColor: normalizeColor(value.lineColor ?? (value as Record<string, unknown>).color as ToolColor | undefined, DEFAULTS.lineColor),
    showWidth: typeof value.showWidth === 'boolean' ? value.showWidth : DEFAULTS.showWidth,
    showHeight: typeof value.showHeight === 'boolean' ? value.showHeight : DEFAULTS.showHeight,
    placement: VALID_PLACEMENTS.includes(String(value.placement) as Placement) ? (String(value.placement) as Placement) : DEFAULTS.placement,
    endpointStyle: (["slash", "line-arrow", "arrow"] as EndpointStyle[]).includes(String(value.endpointStyle) as EndpointStyle) ? (String(value.endpointStyle) as EndpointStyle) : DEFAULTS.endpointStyle,
  }
}

const loadedFonts = new Set<string>()

async function ensureFont(fontName: FontName): Promise<void> {
  if (fontName == null || typeof fontName !== 'object' || !('family' in fontName)) return
  const key = JSON.stringify(fontName)
  if (loadedFonts.has(key)) return
  await figma.loadFontAsync(fontName)
  loadedFonts.add(key)
}

function solidPaint(color: ToolColor): SolidPaint {
  return {
    type: 'SOLID',
    color: { r: color.r, g: color.g, b: color.b },
    opacity: color.a,
  }
}

class VectorPathBuilder {
  private commands: string[] = []
  private precision: number
  constructor(precision = 2) { this.precision = precision }
  private coord(value: number): string {
    const safe = Number.isFinite(value) ? value : 0
    return Number.isInteger(safe) ? String(safe) : Number(safe.toFixed(this.precision)).toString()
  }
  moveTo(x: number, y: number): this {
    this.commands.push('M', this.coord(x), this.coord(y))
    return this
  }
  lineTo(x: number, y: number): this {
    this.commands.push('L', this.coord(x), this.coord(y))
    return this
  }
  curveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.commands.push(
      'C',
      this.coord(c1x), this.coord(c1y),
      this.coord(c2x), this.coord(c2y),
      this.coord(x), this.coord(y),
    )
    return this
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this {
    this.commands.push('Q', this.coord(cx), this.coord(cy), this.coord(x), this.coord(y))
    return this
  }
  close(): this {
    this.commands.push('Z')
    return this
  }
  toPathData(): string {
    return this.commands.join(' ')
  }
  toVectorPath(
    windingRule: 'NONZERO' | 'EVENODD' | 'NONE' = 'NONZERO',
  ): { windingRule: 'NONZERO' | 'EVENODD' | 'NONE'; data: string } {
    return { windingRule, data: this.toPathData() }
  }
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const cross = (p: Point2, q: Point2, r: Point2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - 1e-8 || Math.max(c.x, d.x) < Math.min(a.x, b.x) - 1e-8
    || Math.max(a.y, b.y) < Math.min(c.y, d.y) - 1e-8 || Math.max(c.y, d.y) < Math.min(a.y, b.y) - 1e-8) return false
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b)
  return Math.min(abC, abD) <= 1e-8 && Math.max(abC, abD) >= -1e-8
    && Math.min(cdA, cdB) <= 1e-8 && Math.max(cdA, cdB) >= -1e-8
}

/** A single closed straight boundary, ordered by connectivity, not segment storage. */
function straightPolygonVertices(network: VectorNetwork): Point2[] | null {
  const { vertices, segments } = network
  if (segments.length < 3) return null
  if (network.regions != null && (network.regions.length > 1 || network.regions.some(region => region.loops.length !== 1))) return null
  const adjacent = vertices.map(() => [] as number[])
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const a = vertices[segment.start], b = vertices[segment.end]
    const ts = segment.tangentStart ?? { x: 0, y: 0 }
    const te = segment.tangentEnd ?? { x: 0, y: 0 }
    if (a == null || b == null || ![a.x, a.y, b.x, b.y].every(Number.isFinite)
      || Math.hypot(b.x - a.x, b.y - a.y) <= 0.001
      || ts.x !== 0 || ts.y !== 0 || te.x !== 0 || te.y !== 0) return null
    adjacent[segment.start].push(index)
    adjacent[segment.end].push(index)
  }
  if (adjacent.some(edges => edges.length !== 0 && edges.length !== 2)) return null
  const ordered: Point2[] = []
  const seen = new Set<number>()
  const first = segments[0].start
  let current = first
  let previous = -1
  do {
    if (seen.has(current)) return null
    seen.add(current)
    ordered.push(vertices[current])
    const next = adjacent[current].find(index => index !== previous)
    if (next == null) return null
    const segment = segments[next]
    current = segment.start === current ? segment.end : segment.start
    previous = next
  } while (current !== first)
  if (ordered.length !== segments.length) return null
  for (let index = 0; index < ordered.length; index++) {
    const a = ordered[index], b = ordered[(index + 1) % ordered.length], c = ordered[(index + 2) % ordered.length]
    const dx = b.x - a.x, dy = b.y - a.y, nx = c.x - b.x, ny = c.y - b.y
    if (dx * nx + dy * ny < 0 && Math.abs(dx * ny - dy * nx) <= Math.hypot(dx, dy) * Math.hypot(nx, ny) * 1e-6) return null
    for (let other = index + 2; other < ordered.length; other++) {
      if (index === 0 && other === ordered.length - 1) continue
      if (segmentsIntersect(a, b, ordered[other], ordered[(other + 1) % ordered.length])) return null
    }
  }
  // Remove only forward-collinear joins, including joins across the storage seam.
  return ordered.filter((b, index) => {
    const a = ordered[(index + ordered.length - 1) % ordered.length], c = ordered[(index + 1) % ordered.length]
    const dx = b.x - a.x, dy = b.y - a.y, nx = c.x - b.x, ny = c.y - b.y
    return dx * nx + dy * ny <= 0 || Math.abs(dx * ny - dy * nx) > Math.hypot(dx, dy) * Math.hypot(nx, ny) * 1e-6
  })
}

/** null means unsupported; an empty set retains the existing vector-rectangle path. */
function perimeterEdgesForNode(node: SceneNode): AngledEdge[] | null {
  if (node.type !== 'VECTOR') return null
  const t = node.relativeTransform
  if (!t.every(row => row.every(Number.isFinite))
    || Math.abs(t[0][0] * t[1][1] - t[0][1] * t[1][0]) <= 1e-12) return null
  const boundary = straightPolygonVertices(node.vectorNetwork)
  if (boundary == null || boundary.length < 3) return null
  const points = boundary.map(vertex => ({
    x: t[0][0] * vertex.x + t[0][1] * vertex.y + t[0][2],
    y: t[1][0] * vertex.x + t[1][1] * vertex.y + t[1][2],
  }))
  if (points.some((point, i) => !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || Math.hypot(point.x - points[(i + 1) % points.length].x, point.y - points[(i + 1) % points.length].y) <= 0.001)) return null
  // Translation-relative area gives the exterior even for concave/reflected outlines.
  const origin = points[0]
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + (point.x - origin.x) * (next.y - origin.y) - (next.x - origin.x) * (point.y - origin.y)
  }, 0)
  if (!Number.isFinite(area) || Math.abs(area) <= 0.001) return null
  if (boundary.length === 4 && boundary.every((a, index) => {
    const b = boundary[(index + 1) % 4], c = boundary[(index + 2) % 4]
    return Math.abs((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y))
      <= Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y) * 1e-6
  })) return []
  return points.map((a, index) => {
    const b = points[(index + 1) % points.length]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const insidePoint = { x: (a.x + b.x) / 2 - Math.sign(area) * (b.y - a.y) / length,
      y: (a.y + b.y) / 2 + Math.sign(area) * (b.x - a.x) / length }
    const key = [boundary[index], boundary[(index + 1) % boundary.length]]
      .map(p => p.x + ',' + p.y).sort().join(':')
    // Canonical direction keeps the text upright without changing the exterior.
    const reverse = b.x < a.x || (Math.abs(b.x - a.x) <= 1e-8 && b.y < a.y)
    return { start: reverse ? b : a, end: reverse ? a : b, length, insidePoint, key }
  }).sort((a, b) => a.key.localeCompare(b.key))
}

function outwardNormalForEdge(start: Point2, end: Point2, insidePoint: Point2): Point2 {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length <= 0.001) return { x: 0, y: 0 }
  let normal = { x: -dy / length, y: dx / length }
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const awayFromInside = { x: midpoint.x - insidePoint.x, y: midpoint.y - insidePoint.y }
  if (normal.x * awayFromInside.x + normal.y * awayFromInside.y < 0) normal = { x: -normal.x, y: -normal.y }
  return normal
}

function croppedVectorPosition(points: readonly Point2[], frameOrigin: Point2): Point2 {
  return {
    x: Math.min(...points.map(point => point.x)) - frameOrigin.x,
    y: Math.min(...points.map(point => point.y)) - frameOrigin.y,
  }
}

function transformedTopLeftForCenter(width: number, height: number, transform: Transform, center: Point2): Point2 {
  return {
    x: center.x - (transform[0][0] * width / 2 + transform[0][1] * height / 2),
    y: center.y - (transform[1][0] * width / 2 + transform[1][1] * height / 2),
  }
}

function htmlEscapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function colorToHex(color: ToolColor): string {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return '#' + channel(color.r) + channel(color.g) + channel(color.b) + channel(color.a)
}

function selectionSizeLabel(target: SceneNode, params: Params): string {
  const width = formatMeasurement(target.width * params.scale, params.decimals)
  const height = formatMeasurement(target.height * params.scale, params.decimals)
  return width + '\u00A0×\u00A0' + height + '\u00A0' + params.units
}

function removeSelectionBadge(): void {
  selectionBadgeRevision += 1
  selectionBadgePending = null
  if (selectionBadgeUpdateTimer != null) clearTimeout(selectionBadgeUpdateTimer)
  selectionBadgeUpdateTimer = null
  if (selectionBadge != null && !selectionBadge.removed) selectionBadge.remove()
  selectionBadge = null
  selectionBadgeTarget = null
  selectionBadgeScale = 1
  selectionBadgeLabel = ''
  selectionBadgeSelectedId = ''
}

function isSelectionBadgeNode(node: BaseNode): boolean {
  let ancestor: BaseNode | null = node
  while (ancestor != null && !ancestor.removed) {
    if (ancestor.getPluginData(SELECTION_BADGE_KEY) === '1') return true
    ancestor = ancestor.parent
  }
  return false
}

function removeStaleSelectionBadges(keep: FrameNode | null = null, page: PageNode = figma.currentPage): void {
  if (page.removed) return
  selectionBadgePages.add(page)
  const frames = page.findAllWithCriteria({ types: ['FRAME'] })
  for (const frame of frames) {
    if (frame !== keep && !frame.removed && frame.getPluginData(SELECTION_BADGE_KEY) === '1') frame.remove()
  }
}

function currentSelectionBadgeTarget(): SceneNode | null {
  if (pluginClosed || isExecuting) return null
  const page = figma.currentPage
  if (page.selection.length !== 1) return null
  const target = resolveTarget(page.selection[0])
  if (target == null || target.removed) return null
  let ancestor: BaseNode | null = target
  while (ancestor != null && !ancestor.removed) {
    if (ancestor === page) return target
    ancestor = ancestor.parent
  }
  return null
}

function reconcileSelectionBadge(sweep = false): void {
  if (pluginClosed) return
  const page = figma.currentPage
  const target = currentSelectionBadgeTarget()
  const selectedId = page.selection.length === 1 ? page.selection[0].id : ''
  if (target == null) {
    if (selectionBadge != null || selectionBadgePending != null) removeSelectionBadge()
  } else if (selectionBadge == null || selectionBadge.removed || selectionBadge.parent !== page
    || selectionBadgeTarget !== target || selectionBadgeSelectedId !== selectedId) {
    const pending = selectionBadgePending
    if (pending == null || pending.page !== page || pending.selectedId !== selectedId || pending.targetId !== target.id) {
      void syncSelectionBadge()
    }
  }
  if (sweep) removeStaleSelectionBadges(selectionBadge)
}

function positionSelectionBadge(badge: FrameNode, target: SceneNode): void {
  const rect = target.absoluteBoundingBox
  if (rect == null) {
    badge.visible = false
    return
  }
  badge.visible = true
  badge.rotation = 0
  const scale = selectionBadgeCanvasScale()
  badge.x = rect.x + (rect.width - badge.width) / 2
  badge.y = rect.height >= badge.height + 16 * scale
    ? rect.y + rect.height - badge.height - 8 * scale
    : rect.y - badge.height - 6 * scale
}

function selectionBadgeCanvasScale(): number {
  const zoom = Math.max(0.01, finiteNumber(figma.viewport.zoom, 1))
  return clamp(1 / zoom, 0.01, 100)
}

function setSelectionBadgeScale(badge: FrameNode, scale: number): void {
  if (Math.abs(selectionBadgeScale - 1) > 0.0001) badge.rescale(1 / selectionBadgeScale)
  if (Math.abs(scale - 1) > 0.0001) badge.rescale(scale)
  selectionBadgeScale = scale
}

function renderSelectionBadge(badge: FrameNode, target: SceneNode): void {
  setSelectionBadgeScale(badge, 1)
  for (const child of [...badge.children]) child.remove()

  badge.paddingLeft = 4
  badge.paddingRight = 4
  badge.paddingTop = 1
  badge.paddingBottom = 1
  badge.cornerRadius = 2

  const label = selectionSizeLabel(target, latestParams)
  const text = figma.createText()
  badge.appendChild(text)
  text.name = 'real-size-text'
  text.fontName = SELECTION_BADGE_FONT
  text.fontSize = 11
  text.lineHeight = { value: 14, unit: 'PIXELS' }
  text.letterSpacing = { value: 0, unit: 'PIXELS' }
  setNaturalLabelSizing(text)
  text.characters = label
  text.fills = [solidPaint({ r: 1, g: 1, b: 1, a: 1 })]

  // Preserve the text's original line box after outlining. Flattening crops to
  // the glyph bounds, which otherwise makes the auto-layout padding look too
  // tight—especially vertically—compared with Figma's native size badge.
  const lineBox = figma.createFrame()
  badge.appendChild(lineBox)
  lineBox.name = 'real-size-line-box'
  lineBox.fills = []
  lineBox.clipsContent = false
  lineBox.resize(text.width, text.height)
  lineBox.appendChild(text)
  text.x = 0
  text.y = 0

  // Outline the label before scaling. This avoids Figma's 1 px minimum text
  // size while matching the native fixed-screen-size badge at high zoom.
  const outlinedText = figma.flatten([text], lineBox)
  outlinedText.name = 'real-size-text-outline'
  selectionBadgeLabel = label
  setSelectionBadgeScale(badge, selectionBadgeCanvasScale())
}

function updateSelectionBadge(target: SceneNode): void {
  const badge = selectionBadge
  if (selectionBadgeTarget !== target) return // Ignore updates queued for a previous owner.
  if (badge == null || badge.removed || currentSelectionBadgeTarget() !== target
    || badge.parent !== figma.currentPage || selectionBadgeSelectedId !== figma.currentPage.selection[0]?.id) {
    removeSelectionBadge()
    return
  }
  try {
    const label = selectionSizeLabel(target, latestParams)
    if (label !== selectionBadgeLabel || badge.children.length === 0) {
      renderSelectionBadge(badge, target)
    } else {
      setSelectionBadgeScale(badge, selectionBadgeCanvasScale())
    }
    badge.name = '\u200B'
    positionSelectionBadge(badge, target)
  } catch {
    if (selectionBadge === badge) removeSelectionBadge()
  }
}

function queueSelectionBadgeUpdate(target: SceneNode): void {
  if (selectionBadgeUpdateTimer != null) return
  selectionBadgeUpdateTimer = setTimeout(() => {
    selectionBadgeUpdateTimer = null
    updateSelectionBadge(target)
  }, 16)
}

function setupSelectionBadgeZoomWatch(): void {
  if (selectionBadgeZoomTimer != null) return
  lastSelectionBadgeZoom = figma.viewport.zoom
  let lastReconciliation = Date.now()
  selectionBadgeZoomTimer = setInterval(() => {
    const now = Date.now()
    if (now - lastReconciliation >= 250) {
      lastReconciliation = now
      reconcileSelectionBadge(true)
    }
    const zoom = figma.viewport.zoom
    if (Math.abs(zoom - lastSelectionBadgeZoom) < 0.0001) return
    lastSelectionBadgeZoom = zoom
    if (selectionBadgeTarget != null) updateSelectionBadge(selectionBadgeTarget)
  }, 16)
}

function cleanupPlugin(): void {
  pluginClosed = true
  removeSelectionBadge()
  for (const page of selectionBadgePages) removeStaleSelectionBadges(null, page)
  selectionBadgePages.clear()
  if (autoRefreshPage != null && !autoRefreshPage.removed) autoRefreshPage.off('nodechange', onAutoRefresh)
  autoRefreshPage = null
  figma.off('currentpagechange', onCurrentPageChange)
  annotationRevisions.clear()
  pendingLabels.clear()
  annotationSession += 1
  if (selectionBadgeZoomTimer != null) clearInterval(selectionBadgeZoomTimer)
  selectionBadgeZoomTimer = null
}

async function syncSelectionBadge(): Promise<void> {
  if (pluginClosed) return
  removeSelectionBadge()
  const revision = selectionBadgeRevision
  const page = figma.currentPage
  const target = currentSelectionBadgeTarget()
  const selectedId = page.selection[0]?.id ?? ''
  removeStaleSelectionBadges()
  if (target == null) return
  selectionBadgePending = { revision, page, selectedId, targetId: target.id }

  try {
    await ensureFont(SELECTION_BADGE_FONT)
    if (revision !== selectionBadgeRevision || figma.currentPage !== page
      || page.selection[0]?.id !== selectedId || currentSelectionBadgeTarget() !== target) return

    const badge = figma.createFrame()
    selectionBadge = badge
    selectionBadgeTarget = target
    selectionBadgeSelectedId = selectedId
    badge.setPluginData(SELECTION_BADGE_KEY, '1')
    page.appendChild(badge)
    badge.name = '\u200B'
    badge.layoutMode = 'HORIZONTAL'
    badge.primaryAxisSizingMode = 'AUTO'
    badge.counterAxisSizingMode = 'AUTO'
    badge.fills = [solidPaint({ r: 13 / 255, g: 153 / 255, b: 1, a: 1 })]
    badge.clipsContent = false

    selectionBadgeScale = 1
    selectionBadgeLabel = ''
    renderSelectionBadge(badge, target)

    badge.name = '\u200B'
    badge.locked = true
    positionSelectionBadge(badge, target)
  } catch {
    if (revision === selectionBadgeRevision) removeSelectionBadge()
  } finally {
    if (selectionBadgePending?.revision === revision) selectionBadgePending = null
  }
}

// ── Overlap detection ──────────────────────────────────────────────────

interface DimRect { x: number; y: number; w: number; h: number }

function getObstacleRects(target: SceneNode): DimRect[] {
  if (target.removed) return []
  const parent = target.parent
  if (parent == null || !('children' in parent)) return []
  const rects: DimRect[] = []
  for (const child of parent.children) {
    if (child.id === target.id) continue
    if (!child.visible) continue
    // Skip dimension frames — they shouldn't influence auto-placement
    if (isDimFrame(child)) continue
    const bb = child.absoluteBoundingBox
    if (bb != null) {
      rects.push({ x: bb.x, y: bb.y, w: bb.width, h: bb.height })
    }
  }
  return rects
}

function clearance(targetBB: DimRect, obstacles: DimRect[], side: 'top' | 'bottom' | 'left' | 'right'): number {
  let minDist = Infinity
  const tLeft = targetBB.x
  const tRight = targetBB.x + targetBB.w
  const tTop = targetBB.y
  const tBottom = targetBB.y + targetBB.h

  for (const s of obstacles) {
    const sLeft = s.x
    const sRight = s.x + s.w
    const sTop = s.y
    const sBottom = s.y + s.h

    // Use relaxed overlap detection: count obstacles that extend past the
    // target edge (even if they also overlap the target itself). Clearance
    // is clamped to 0 for overlapping/touching obstacles.
    if (side === 'bottom') {
      if (sLeft < tRight && sRight > tLeft && sBottom > tBottom) minDist = Math.min(minDist, Math.max(0, sTop - tBottom))
    } else if (side === 'top') {
      if (sLeft < tRight && sRight > tLeft && sTop < tTop) minDist = Math.min(minDist, Math.max(0, tTop - sBottom))
    } else if (side === 'right') {
      if (sTop < tBottom && sBottom > tTop && sRight > tRight) minDist = Math.min(minDist, Math.max(0, sLeft - tRight))
    } else if (side === 'left') {
      if (sTop < tBottom && sBottom > tTop && sLeft < tLeft) minDist = Math.min(minDist, Math.max(0, tLeft - sRight))
    }
  }
  return minDist
}

function availableClearance(target: SceneNode, side: 'top' | 'bottom' | 'left' | 'right'): number {
  const bb = target.absoluteBoundingBox
  if (bb == null) return -Infinity
  const targetRect: DimRect = { x: bb.x, y: bb.y, w: bb.width, h: bb.height }
  let available = clearance(targetRect, getObstacleRects(target), side)

  const parent = target.parent
  if (parent != null && 'absoluteBoundingBox' in parent && 'width' in parent) {
    const pbb = (parent as SceneNode).absoluteBoundingBox
    if (pbb != null) {
      if (side === 'bottom') available = Math.min(available, pbb.y + pbb.height - (bb.y + bb.height))
      else if (side === 'top') available = Math.min(available, bb.y - pbb.y)
      else if (side === 'right') available = Math.min(available, pbb.x + pbb.width - (bb.x + bb.width))
      else available = Math.min(available, bb.x - pbb.x)
    }
  }

  return available
}

function resolveAutoPlacement(target: SceneNode, params: Params): { widthSide: 'top' | 'bottom'; heightSide: 'left' | 'right' } {
  const bb = target.absoluteBoundingBox
  if (bb == null) return { widthSide: 'bottom', heightSide: 'right' }
  const annotationDepth = params.offset + params.fontSize + 10

  const bottomClear = availableClearance(target, 'bottom')
  const topClear = availableClearance(target, 'top')
  const rightClear = availableClearance(target, 'right')
  const leftClear = availableClearance(target, 'left')

  let widthSide: 'top' | 'bottom'
  if (bottomClear >= annotationDepth && topClear < annotationDepth) widthSide = 'bottom'
  else if (topClear >= annotationDepth && bottomClear < annotationDepth) widthSide = 'top'
  else widthSide = bottomClear >= topClear ? 'bottom' : 'top'

  let heightSide: 'left' | 'right'
  if (rightClear >= annotationDepth && leftClear < annotationDepth) heightSide = 'right'
  else if (leftClear >= annotationDepth && rightClear < annotationDepth) heightSide = 'left'
  else heightSide = rightClear >= leftClear ? 'right' : 'left'

  return { widthSide, heightSide }
}

function placementToSides(placement: Placement, target: SceneNode, params: Params): { widthSide: 'top' | 'bottom'; heightSide: 'left' | 'right' } {
  switch (placement) {
    case 'auto': return resolveAutoPlacement(target, params)
    case 'up': return { widthSide: 'top', heightSide: 'right' }
    case 'down': return { widthSide: 'bottom', heightSide: 'right' }
    case 'left': return { widthSide: 'bottom', heightSide: 'left' }
    case 'right': return { widthSide: 'bottom', heightSide: 'right' }
  }
}

// ── Dimension component builders ──────────────────────────────────────
// Constraint-based positioning (NO auto-layout). Children use Figma
// constraints so the line stretches, ticks pin to edges, and extension
// lines stay attached when the user resizes the component.

const TICK = 6
const ARROW_BASE_HALF = Math.round(TICK * 0.45) // ~3 — half the arrow base width
const EXT_GAP = 2  // gap between annotated shape edge and extension line start

function endpointTipInset(style: EndpointStyle, weight: number): number {
  // Inset the whole open V so its painted miter tip meets the nominal endpoint.
  return style === 'line-arrow' ? weight * Math.hypot(TICK, ARROW_BASE_HALF) / (2 * ARROW_BASE_HALF) : 0
}

function makeTick45(paint: SolidPaint, weight: number): VectorNode {
  const tickSize = TICK * 2
  const v = figma.createVector()
  const b = new VectorPathBuilder()
  b.moveTo(0, tickSize)
  b.lineTo(tickSize, 0)
  v.vectorPaths = [b.toVectorPath('NONZERO')]
  v.strokes = [paint]
  v.strokeWeight = weight
  v.fills = []
  return v
}

/** Create a filled triangular arrowhead, or an open V when weight is positive.
 *  The arrow tip is always at (TICK, TICK) — the center of the tickSize×tickSize
 *  bounding box — so it aligns with the dimension line endpoint regardless of
 *  placement side.  The base extends to the box edge AWAY from the line.
 *  direction: which way the arrow points (toward the dim-line center). */
function makeArrow(paint: SolidPaint, direction: 'left' | 'right' | 'up' | 'down', weight = 0): VectorNode {
  const tickSize = TICK * 2           // 12 — bounding box size
  const tip = TICK                    // 6 — center of box, at the dim-line endpoint
  const baseHalf = ARROW_BASE_HALF    // ~3 — half the base width (narrow arrow)
  const v = figma.createVector()
  const b = new VectorPathBuilder()
  if (direction === 'left') {
    // Tip at center, base at right edge
    b.moveTo(tickSize, tip - baseHalf); b.lineTo(tip, tip); b.lineTo(tickSize, tip + baseHalf)
  } else if (direction === 'right') {
    // Tip at center, base at left edge
    b.moveTo(0, tip - baseHalf); b.lineTo(tip, tip); b.lineTo(0, tip + baseHalf)
  } else if (direction === 'up') {
    // Tip at center, base at bottom edge
    b.moveTo(tip - baseHalf, tickSize); b.lineTo(tip, tip); b.lineTo(tip + baseHalf, tickSize)
  } else {
    // Tip at center, base at top edge
    b.moveTo(tip - baseHalf, 0); b.lineTo(tip, tip); b.lineTo(tip + baseHalf, 0)
  }
  if (weight === 0) b.close()
  v.vectorPaths = [b.toVectorPath('NONZERO')]
  v.fills = weight === 0 ? [paint] : []
  v.strokes = weight > 0 ? [paint] : []
  if (weight > 0) {
    v.strokeWeight = weight
    v.strokeCap = 'NONE'
    v.strokeJoin = 'MITER'
  }
  return v
}

function makeEndpoint(style: EndpointStyle, paint: SolidPaint, weight: number, arrowDir: 'left' | 'right' | 'up' | 'down' = 'left'): VectorNode {
  return style === 'slash' ? makeTick45(paint, weight) : makeArrow(paint, arrowDir, style === 'line-arrow' ? weight : 0)
}

function tightAnnotationBounds(rects: readonly DimRect[]): DimRect | null {
  if (rects.length === 0) return null
  const x = Math.min(...rects.map(rect => rect.x))
  const y = Math.min(...rects.map(rect => rect.y))
  const right = Math.max(...rects.map(rect => rect.x + rect.w))
  const bottom = Math.max(...rects.map(rect => rect.y + rect.h))
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) }
}

function fitAngledAnnotationFrame(frame: FrameNode): void {
  const children = [...frame.children]
  const rects = children.map(child => {
    const transform = child.relativeTransform
    const corners = [[0, 0], [child.width, 0], [0, child.height], [child.width, child.height]]
    const points = corners.map(([x, y]) => ({
      x: transform[0][0] * x + transform[0][1] * y + transform[0][2],
      y: transform[1][0] * x + transform[1][1] * y + transform[1][2],
    }))
    const strokePadding = 'strokeWeight' in child && typeof child.strokeWeight === 'number'
      && 'strokes' in child && child.strokes.length > 0 ? child.strokeWeight / 2 : 0
    const x = Math.min(...points.map(point => point.x)) - strokePadding
    const y = Math.min(...points.map(point => point.y)) - strokePadding
    const right = Math.max(...points.map(point => point.x)) + strokePadding
    const bottom = Math.max(...points.map(point => point.y)) + strokePadding
    return { x, y, w: right - x, h: bottom - y }
  })
  const bounds = tightAnnotationBounds(rects)
  if (bounds == null) return
  const originalX = frame.x
  const originalY = frame.y
  const positions = children.map(child => ({ child, x: child.x, y: child.y }))
  frame.resizeWithoutConstraints(bounds.w, bounds.h)
  frame.x = originalX + bounds.x
  frame.y = originalY + bounds.y
  for (const { child, x, y } of positions) {
    child.x = x - bounds.x
    child.y = y - bounds.y
  }
}

/** Bounded, conservative text-box clearance; never changes the measured span. */
function perimeterClearance(edge: AngledEdge, params: Params, width: number, height: number,
  edges: readonly AngledEdge[], labels: readonly DimRect[]): { offset: number; rect: DimRect } {
  const normal = outwardNormalForEdge(edge.start, edge.end, edge.insidePoint!)
  const dx = (edge.end.x - edge.start.x) / edge.length, dy = (edge.end.y - edge.start.y) / edge.length
  const w = Math.abs(dx) * width + Math.abs(dy) * height + 8
  const h = Math.abs(dy) * width + Math.abs(dx) * height + 8
  const support = edges.reduce((max, e) => Math.max(max,
    (e.start.x - edge.start.x) * normal.x + (e.start.y - edge.start.y) * normal.y,
    (e.end.x - edge.start.x) * normal.x + (e.end.y - edge.start.y) * normal.y), 0)
  const escapeOffset = support + TICK + Math.max(0,
    (Math.abs(normal.x) * w + Math.abs(normal.y) * h) / 2 - params.labelOffset - height / 2)
  const inside = (p: Point2) => {
    let result = false
    for (const e of edges) {
      const a = e.start, b = e.end
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) result = !result
    }
    return result
  }
  let best: { offset: number; rect: DimRect; score: number } | null = null
  for (let attempt = 0; attempt <= 16; attempt++) {
    // The last candidate escapes the polygon's support plane, even in a deep notch.
    const offset = Math.max(params.offset + attempt * (params.fontSize + 8), attempt === 16 ? escapeOffset : 0)
    const distance = offset + params.labelOffset + height / 2
    const center = { x: (edge.start.x + edge.end.x) / 2 + normal.x * distance,
      y: (edge.start.y + edge.end.y) / 2 + normal.y * distance }
    const rect = { x: center.x - w / 2, y: center.y - h / 2, w, h }
    const corners = [{ x: rect.x, y: rect.y }, { x: rect.x + w, y: rect.y },
      { x: rect.x + w, y: rect.y + h }, { x: rect.x, y: rect.y + h }]
    const q1 = { x: edge.start.x + normal.x * offset, y: edge.start.y + normal.y * offset }
    const q2 = { x: edge.end.x + normal.x * offset, y: edge.end.y + normal.y * offset }
    if (inside(q1) || inside(q2) || edges.some(e => segmentsIntersect(q1, q2, e.start, e.end))) continue
    if (corners.some(inside) || edges.some(e => corners.some((p, i) => segmentsIntersect(p, corners[(i + 1) % 4], e.start, e.end))
      || (e.start.x >= rect.x && e.start.x <= rect.x + w && e.start.y >= rect.y && e.start.y <= rect.y + h))) continue
    const score = labels.filter(r => r.x < rect.x + w && r.x + r.w > rect.x && r.y < rect.y + h && r.y + r.h > rect.y).length
    if (best == null || score < best.score) best = { offset, rect, score }
    if (score === 0) break
  }
  return best!
}

async function createPerimeterDimensions(target: SceneNode, edges: readonly AngledEdge[], params: Params): Promise<SceneNode[]> {
  const nodes: SceneNode[] = []
  const labels: DimRect[] = []
  for (const edge of edges) {
    const dim = await createAngledDimension(target, edge, params, { edges, labels })
    if (dim != null) nodes.push(dim)
  }
  return nodes
}

async function createAngledDimension(target: SceneNode, edge: AngledEdge, params: Params,
  clearanceContext?: { edges: readonly AngledEdge[]; labels: DimRect[] }): Promise<FrameNode | null> {
  if (Math.abs(edge.end.x - edge.start.x) <= edge.length * 1e-8 && edge.end.y < edge.start.y) {
    edge = { ...edge, start: edge.end, end: edge.start }
  }
  const parent = target.parent
  if (parent == null || !('appendChild' in parent)) return null
  const selectedFont: FontName = { family: params.fontFamily, style: 'Regular' }
  await ensureFont(selectedFont)

  const dx = edge.end.x - edge.start.x
  const dy = edge.end.y - edge.start.y
  const length = Math.hypot(dx, dy)
  if (length <= 0.001) return null
  const targetRect = nodeRect(target)
  const targetCenter = { x: targetRect.x + targetRect.w / 2, y: targetRect.y + targetRect.h / 2 }
  const normal = outwardNormalForEdge(edge.start, edge.end, edge.insidePoint ?? targetCenter)
  const vertical = Math.abs(dx) <= length * 1e-8
  const side = vertical ? (normal.x < 0 ? 'left' : 'right')
    : (dx * normal.y - dy * normal.x < 0 ? 'top' : 'bottom')
  const meta: DimMeta = { axis: vertical ? 'v' : 'h', side, scale: params.scale, units: params.units, decimals: params.decimals, measuredSpan: length, edgeLinear: true }
  if (edge.key != null) meta.perimeterEdge = edge.key
  const label = formatDimValue(edge.length, meta)
  const text = figma.createText()
  text.name = 'dim-text'
  text.fontName = selectedFont
  text.fontSize = params.fontSize
  text.lineHeight = { value: params.fontSize, unit: 'PIXELS' }
  setNaturalLabelSizing(text)
  text.characters = label
  text.fills = [solidPaint(params.fontColor)]
  if (clearanceContext != null) {
    const result = perimeterClearance(edge, params, text.width, text.height, clearanceContext.edges, clearanceContext.labels)
    clearanceContext.labels.push(result.rect)
    meta.clearanceExtra = result.offset - params.offset
    params = { ...params, offset: result.offset }
  }

  text.remove() // Clearance uses loaded text metrics; the linear builder authors the label.
  const fontPaint = solidPaint(params.fontColor), linePaint = solidPaint(params.lineColor)
  const frame = vertical
    ? await createVDimFrame(length, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, side as 'left' | 'right', params.endpointStyle)
    : await createHDimFrame(length, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, side as 'top' | 'bottom', params.endpointStyle)
  ;(parent as BaseNode & ChildrenMixin).appendChild(frame)
  if ('layoutMode' in parent && parent.layoutMode !== 'NONE') frame.layoutPositioning = 'ABSOLUTE'
  const basis: Transform = vertical ? [[1, 0, edge.start.x], [0, 1, edge.start.y]]
    : [[dx / length, -dy / length, edge.start.x], [dy / length, dx / length, edge.start.y]]
  frame.relativeTransform = annotationTransform(basis, side === 'left' ? -frame.width : 0, side === 'top' ? -frame.height : 0)
  frame.setPluginData(DIM_TARGET_KEY, target.id)
  return frame
}



/**
 * Horizontal dimension frame (constraint-based, no auto-layout).
 * Frame height includes the offset distance — dragging taller stretches extension lines.
 * Layout (top-to-bottom for "bottom" placement):
 *   extension lines STRETCH from top (with EXT_OVER overshoot) down to dim-line area
 *   dim-line-frame pinned to bottom (MAX), fixed height
 *   dim-text pinned to very bottom (MAX), fixed height
 */
async function createHDimFrame(
  measuredWidth: number,
  meta: DimMeta,
  fontPaint: SolidPaint,
  linePaint: SolidPaint,
  fontSize: number,
  fontFamily: string,
  offset: number,
  labelOffset: number,
  sw: number,
  side: 'top' | 'bottom',
  endpointStyle: EndpointStyle,
): Promise<FrameNode> {
  const selectedFont: FontName = { family: fontFamily, style: 'Regular' }
  await ensureFont(selectedFont)

  const tickSize = TICK * 2
  const label = formatDimValue(measuredWidth, meta)
  // Endpoint artwork may overflow, but must never inflate the measurement.
  const w = Math.max(measuredWidth, 0.01)
  const inset = endpointTipInset(endpointStyle, sw)

  // Measure text height
  const text = figma.createText()
  text.name = 'dim-text'
  text.fontName = selectedFont
  text.fontSize = fontSize
  text.lineHeight = { value: fontSize, unit: 'PIXELS' }
  setNaturalLabelSizing(text)
  text.characters = label
  text.textAlignHorizontal = 'CENTER'
  text.fills = [fontPaint]
  const textH = text.height

  const lineFrameH = tickSize
  // offset = distance from shape edge to dim-line center
  // labelOffset = distance from dim-line center to label text
  const gapBeforeLine = offset - TICK
  const frameH = offset + labelOffset + textH

  // Frame — NO auto-layout, NOT a component
  const frame = figma.createFrame()
  frame.name = label
  frame.fills = []
  frame.clipsContent = false
  frame.resize(w, frameH)

  // Line+ticks sub-frame
  const lineFrame = figma.createFrame()
  lineFrame.name = 'dim-line-frame'
  lineFrame.fills = []
  lineFrame.clipsContent = false
  lineFrame.resize(w, lineFrameH)

  if (side === 'bottom') {
    // Line frame pinned above text at bottom
    lineFrame.x = 0
    lineFrame.y = gapBeforeLine
    lineFrame.constraints = { horizontal: 'STRETCH', vertical: 'MAX' }

    // Keep the natural single-line label width even on very short spans.
    text.x = (w - text.width) / 2
    text.y = frameH - textH
    text.constraints = { horizontal: 'CENTER', vertical: 'MAX' }
  } else {
    // "top" placement: text at top, line below it, extension lines go downward
    text.x = (w - text.width) / 2
    text.y = 0
    text.constraints = { horizontal: 'CENTER', vertical: 'MIN' }

    lineFrame.x = 0
    lineFrame.y = textH + labelOffset - TICK
    lineFrame.constraints = { horizontal: 'STRETCH', vertical: 'MIN' }
  }

  // Dimension line (stretches horizontally)
  const dimLine = figma.createLine()
  dimLine.name = 'dim-line'
  dimLine.strokes = [linePaint]
  dimLine.strokeWeight = sw
  dimLine.resize(w, 0)
  dimLine.x = 0
  dimLine.y = lineFrameH / 2
  dimLine.constraints = { horizontal: 'STRETCH', vertical: 'CENTER' }
  lineFrame.appendChild(dimLine)

  // Left endpoint (arrow points left = outward, body extends inside dim line)
  const leftTick = makeEndpoint(endpointStyle, linePaint, sw, 'left')
  leftTick.name = 'tick-l'
  if (endpointStyle !== 'slash') {
    // Figma auto-crops arrow to 6×6; tip of 'left' arrow is at local (0, 3).
    // Match the native horizontal line's half-pixel rendered-center offset.
    leftTick.x = inset
    leftTick.y = TICK - ARROW_BASE_HALF - 0.5
  } else {
    leftTick.x = -TICK
    leftTick.y = 0
  }
  leftTick.constraints = { horizontal: 'MIN', vertical: 'MIN' }
  lineFrame.appendChild(leftTick)

  // Right endpoint (arrow points right = outward, body extends inside dim line)
  const rightTick = makeEndpoint(endpointStyle, linePaint, sw, 'right')
  rightTick.name = 'tick-r'
  if (endpointStyle !== 'slash') {
    // Figma auto-crops arrow to 6×6; tip of 'right' arrow is at local (6, 3).
    // Match the same half-pixel optical correction as the left arrow.
    rightTick.x = w - TICK - inset
    rightTick.y = TICK - ARROW_BASE_HALF - 0.5
  } else {
    rightTick.x = w - TICK
    rightTick.y = 0
  }
  rightTick.constraints = { horizontal: 'MAX', vertical: 'MIN' }
  lineFrame.appendChild(rightTick)

  frame.appendChild(lineFrame)
  frame.appendChild(text)

  // Extension lines — stroked lines that STRETCH vertically.
  // Apply half-pixel optical alignment to both vertical extension lines.
  const extLx = -0.5
  const extRx = w - 0.5
  if (side === 'bottom') {
    // Start extension lines EXT_GAP below frame top (= gap from shape edge)
    const extY = EXT_GAP
    const extH = gapBeforeLine - EXT_GAP + lineFrameH  // from gap to through lineFrame

    const extL = figma.createLine()
    extL.name = 'ext-l'
    extL.strokes = [linePaint]
    extL.strokeWeight = sw
    extL.rotation = -90
    extL.resize(extH, 0)
    extL.x = extLx
    extL.y = extY
    extL.constraints = { horizontal: 'MIN', vertical: 'STRETCH' }
    frame.appendChild(extL)

    const extR = figma.createLine()
    extR.name = 'ext-r'
    extR.strokes = [linePaint]
    extR.strokeWeight = sw
    extR.rotation = -90
    extR.resize(extH, 0)
    extR.x = extRx
    extR.y = extY
    extR.constraints = { horizontal: 'MAX', vertical: 'STRETCH' }
    frame.appendChild(extR)
  } else {
    // "top" placement: extensions go downward from line, stopping EXT_GAP before frame bottom
    const extY = textH + labelOffset - TICK
    const extH = lineFrameH + gapBeforeLine - EXT_GAP  // stop before shape edge

    const extL = figma.createLine()
    extL.name = 'ext-l'
    extL.strokes = [linePaint]
    extL.strokeWeight = sw
    extL.rotation = -90
    extL.resize(extH, 0)
    extL.x = extLx
    extL.y = extY
    extL.constraints = { horizontal: 'MIN', vertical: 'STRETCH' }
    frame.appendChild(extL)

    const extR = figma.createLine()
    extR.name = 'ext-r'
    extR.strokes = [linePaint]
    extR.strokeWeight = sw
    extR.rotation = -90
    extR.resize(extH, 0)
    extR.x = extRx
    extR.y = extY
    extR.constraints = { horizontal: 'MAX', vertical: 'STRETCH' }
    frame.appendChild(extR)
  }

  frame.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
  return frame
}

/**
 * Vertical dimension frame (constraint-based, no auto-layout).
 * Frame width includes the offset distance — dragging wider stretches extension lines.
 */
async function createVDimFrame(
  measuredHeight: number,
  meta: DimMeta,
  fontPaint: SolidPaint,
  linePaint: SolidPaint,
  fontSize: number,
  fontFamily: string,
  offset: number,
  labelOffset: number,
  sw: number,
  side: 'left' | 'right',
  endpointStyle: EndpointStyle,
): Promise<FrameNode> {
  const selectedFont: FontName = { family: fontFamily, style: 'Regular' }
  await ensureFont(selectedFont)

  const tickSize = TICK * 2
  const label = formatDimValue(measuredHeight, meta)
  // Center the label on the real span, not a minimum endpoint-sized frame.
  const h = Math.max(measuredHeight, 0.01)
  const inset = endpointTipInset(endpointStyle, sw)

  // Create rotated text to measure visual width
  const text = figma.createText()
  text.name = 'dim-text'
  text.fontName = selectedFont
  text.fontSize = fontSize
  text.lineHeight = { value: fontSize, unit: 'PIXELS' }
  setNaturalLabelSizing(text)
  text.characters = label
  text.textAlignHorizontal = 'CENTER'
  text.fills = [fontPaint]
  text.rotation = 90
  const vTextW = text.height  // visual width after 90° rotation

  const lineFrameW = tickSize
  // offset = distance from shape edge to dim-line center
  // labelOffset = distance from dim-line center to label text
  const gapBeforeLine = offset - TICK
  const frameW = offset + labelOffset + vTextW

  // Frame — NO auto-layout, NOT a component
  const frame = figma.createFrame()
  frame.name = label
  frame.fills = []
  frame.clipsContent = false
  frame.resize(frameW, h)

  // Line+ticks sub-frame
  const lineFrame = figma.createFrame()
  lineFrame.name = 'dim-line-frame'
  lineFrame.fills = []
  lineFrame.clipsContent = false
  lineFrame.resize(lineFrameW, h)

  if (side === 'right') {
    // Line frame pinned to right side, before text
    lineFrame.x = gapBeforeLine
    lineFrame.y = 0
    lineFrame.constraints = { horizontal: 'MAX', vertical: 'STRETCH' }

    text.x = frameW - vTextW  // position so text left edge aligns with labelOffset gap from line
    text.y = (h + text.width) / 2
    text.constraints = { horizontal: 'MAX', vertical: 'CENTER' }
  } else {
    // "left" placement: text at left, line to its right
    text.x = 0  // text AABB occupies 0..vTextW, then labelOffset gap, then lineFrame
    text.y = (h + text.width) / 2
    text.constraints = { horizontal: 'MIN', vertical: 'CENTER' }

    lineFrame.x = vTextW + labelOffset - TICK
    lineFrame.y = 0
    lineFrame.constraints = { horizontal: 'MIN', vertical: 'STRETCH' }
  }

  // Dimension line (stretches vertically)
  const dimLine = figma.createLine()
  dimLine.name = 'dim-line'
  dimLine.strokes = [linePaint]
  dimLine.strokeWeight = sw
  dimLine.rotation = -90
  dimLine.resize(h, 0)
  dimLine.x = lineFrameW / 2
  dimLine.y = 0
  dimLine.constraints = { horizontal: 'CENTER', vertical: 'STRETCH' }
  lineFrame.appendChild(dimLine)

  // Top endpoint (arrow points up = outward, body extends inside dim line)
  const topTick = makeEndpoint(endpointStyle, linePaint, sw, 'up')
  topTick.name = 'tick-t'
  if (endpointStyle !== 'slash') {
    // Figma auto-crops arrow to 6×6; tip of 'up' arrow is at local (3, 0).
    // Match the native vertical line's half-pixel rendered-center offset.
    topTick.x = TICK - ARROW_BASE_HALF + 0.5
    topTick.y = inset
  } else {
    topTick.x = 0
    topTick.y = -TICK
  }
  topTick.constraints = { horizontal: 'MIN', vertical: 'MIN' }
  lineFrame.appendChild(topTick)

  // Bottom endpoint (arrow points down = outward, body extends inside dim line)
  const botTick = makeEndpoint(endpointStyle, linePaint, sw, 'down')
  botTick.name = 'tick-b'
  if (endpointStyle !== 'slash') {
    // Figma auto-crops arrow to 6×6; tip of 'down' arrow is at local (3, 6).
    // Match the same half-pixel optical correction as the top arrow.
    botTick.x = TICK - ARROW_BASE_HALF + 0.5
    botTick.y = h - TICK - inset
  } else {
    botTick.x = 0
    botTick.y = h - TICK
  }
  botTick.constraints = { horizontal: 'MIN', vertical: 'MAX' }
  lineFrame.appendChild(botTick)

  frame.appendChild(lineFrame)
  frame.appendChild(text)

  // Extension lines — stroked lines that STRETCH horizontally.
  // Position at shape edges: sw/2 offset centers the stroke on the edge pixel.
  const extTy = sw / 2
  const extBy = h - sw / 2 + 1
  if (side === 'right') {
    // Start extension lines EXT_GAP inside frame left (= gap from shape edge)
    const extX = EXT_GAP
    const extW = gapBeforeLine - EXT_GAP + lineFrameW  // from gap to through lineFrame

    const extT = figma.createLine()
    extT.name = 'ext-t'
    extT.strokes = [linePaint]
    extT.strokeWeight = sw
    extT.resize(extW, 0)
    extT.x = extX
    extT.y = extTy
    extT.constraints = { horizontal: 'STRETCH', vertical: 'MIN' }
    frame.appendChild(extT)

    const extB = figma.createLine()
    extB.name = 'ext-b'
    extB.strokes = [linePaint]
    extB.strokeWeight = sw
    extB.resize(extW, 0)
    extB.x = extX
    extB.y = extBy
    extB.constraints = { horizontal: 'STRETCH', vertical: 'MAX' }
    frame.appendChild(extB)
  } else {
    // "left" placement: extensions go rightward from line, stopping EXT_GAP before shape edge
    const extX = vTextW + labelOffset - TICK
    const extW = lineFrameW + gapBeforeLine - EXT_GAP  // stop before shape edge

    const extT = figma.createLine()
    extT.name = 'ext-t'
    extT.strokes = [linePaint]
    extT.strokeWeight = sw
    extT.resize(extW, 0)
    extT.x = extX
    extT.y = extTy
    extT.constraints = { horizontal: 'STRETCH', vertical: 'MIN' }
    frame.appendChild(extT)

    const extB = figma.createLine()
    extB.name = 'ext-b'
    extB.strokes = [linePaint]
    extB.strokeWeight = sw
    extB.resize(extW, 0)
    extB.x = extX
    extB.y = extBy
    extB.constraints = { horizontal: 'STRETCH', vertical: 'MAX' }
    frame.appendChild(extB)
  }

  frame.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
  return frame
}

// ── Dimension builder ──────────────────────────────────────────────────

/** Only native circular ellipses/arcs have a single constant radius. */
function circularRadius(node: SceneNode): number | null {
  if (node.type !== 'ELLIPSE' || node.width <= 0 || node.height <= 0) return null
  const t = node.relativeTransform
  const sx = Math.hypot(t[0][0], t[1][0])
  const sy = Math.hypot(t[0][1], t[1][1])
  const rx = node.width * sx / 2
  const ry = node.height * sy / 2
  if (sx <= 0 || sy <= 0 || Math.abs(rx - ry) > Math.max(rx, ry) * 0.0001) return null
  if (Math.abs(t[0][0] * t[0][1] + t[1][0] * t[1][1]) > sx * sy * 0.0001) return null
  return rx
}

function radiusAttachmentAngle(start: number, end: number, preferred: number): number {
  const turn = Math.PI * 2
  const sweep = end - start
  if (Math.abs(sweep) >= turn - 0.0001) return preferred
  const sign = sweep < 0 ? -1 : 1
  const length = Math.abs(sweep)
  const delta = ((sign * (preferred - start)) % turn + turn) % turn
  // Keep an arrow away from a sector's straight cut edges.
  const inset = Math.min(0.15, length / 4)
  if (delta >= inset && delta <= length - inset) return preferred
  return start + sweep / 2
}

function radiusDirection(placement: Placement, sides: DimensionSides): Point2 {
  const x = placement === 'left' ? -1 : placement === 'right' ? 1 : sides.heightSide === 'left' ? -1 : 1
  const y = placement === 'up' ? -1 : placement === 'down' ? 1 : sides.widthSide === 'top' ? -1 : 1
  return { x: x / Math.SQRT2, y: y / Math.SQRT2 }
}

async function createRadiusDimension(target: EllipseNode, params: Params): Promise<FrameNode | null> {
  const radius = circularRadius(target)
  const parent = target.parent
  if (radius == null || parent == null || !('appendChild' in parent)) return null
  const font: FontName = { family: params.fontFamily, style: 'Regular' }
  await ensureFont(font)
  const t = target.relativeTransform
  const desired = radiusDirection(params.placement, placementToSides(params.placement, target, params))
  const determinant = t[0][0] * t[1][1] - t[0][1] * t[1][0]
  const localDirection = {
    x: (t[1][1] * desired.x - t[0][1] * desired.y) / determinant,
    y: (-t[1][0] * desired.x + t[0][0] * desired.y) / determinant,
  }
  const angle = radiusAttachmentAngle(target.arcData.startingAngle, target.arcData.endingAngle, Math.atan2(localDirection.y, localDirection.x))
  const center = {
    x: t[0][2] + t[0][0] * target.width / 2 + t[0][1] * target.height / 2,
    y: t[1][2] + t[1][0] * target.width / 2 + t[1][1] * target.height / 2,
  }
  const edge = {
    x: center.x + t[0][0] * target.width / 2 * Math.cos(angle) + t[0][1] * target.height / 2 * Math.sin(angle),
    y: center.y + t[1][0] * target.width / 2 * Math.cos(angle) + t[1][1] * target.height / 2 * Math.sin(angle),
  }
  const direction = { x: (edge.x - center.x) / radius, y: (edge.y - center.y) / radius }
  const elbow = { x: edge.x + direction.x * params.offset, y: edge.y + direction.y * params.offset }
  const labelSide = direction.x < 0 ? -1 : 1
  const meta: DimMeta = { axis: 'r', scale: params.scale, units: params.units, decimals: params.decimals, radiusParams: { ...params }, measuredSpan: radius }
  const label = formatDimValue(radius, meta)
  const text = figma.createText()
  text.name = 'dim-text'
  text.fontName = font
  text.fontSize = params.fontSize
  text.lineHeight = { value: params.fontSize, unit: 'PIXELS' }
  setNaturalLabelSizing(text)
  text.characters = label
  text.fills = [solidPaint(params.fontColor)]

  const frame = figma.createFrame()
  frame.fills = []
  frame.clipsContent = false
  ;(parent as BaseNode & ChildrenMixin).appendChild(frame)
  if ('layoutMode' in parent && parent.layoutMode !== 'NONE') frame.layoutPositioning = 'ABSOLUTE'
  frame.x = 0
  frame.y = 0
  frame.appendChild(text)
  text.x = labelSide > 0 ? elbow.x + params.labelOffset : elbow.x - params.labelOffset - text.width
  text.y = elbow.y - params.labelOffset - text.height
  const landing = { x: elbow.x + labelSide * (params.labelOffset + text.width), y: elbow.y }
  const linePoints = [center, elbow, landing]
  const lines = new VectorPathBuilder()
  lines.moveTo(center.x, center.y).lineTo(elbow.x, elbow.y).lineTo(landing.x, landing.y)
  const geometry = figma.createVector()
  geometry.name = 'radius-leader'
  geometry.vectorPaths = [lines.toVectorPath('NONZERO')]
  geometry.fills = []
  geometry.strokes = [solidPaint(params.lineColor)]
  geometry.strokeWeight = params.strokeWeight
  frame.appendChild(geometry)
  const position = croppedVectorPosition(linePoints, { x: 0, y: 0 })
  geometry.x = position.x
  geometry.y = position.y

  // Radius dimensions always use one arrow touching the curved boundary.
  // The external arrow points inward; the center end has no endpoint tick.
  const arrowLength = Math.min(TICK, Math.max(1, radius / 3))
  const half = arrowLength / 2
  const base = { x: edge.x + direction.x * arrowLength, y: edge.y + direction.y * arrowLength }
  const a = { x: base.x - direction.y * half, y: base.y + direction.x * half }
  const b = { x: base.x + direction.y * half, y: base.y - direction.x * half }
  const arrowPath = new VectorPathBuilder()
  arrowPath.moveTo(edge.x, edge.y).lineTo(a.x, a.y).lineTo(b.x, b.y).close()
  const arrow = figma.createVector()
  arrow.name = 'radius-arrow'
  arrow.vectorPaths = [arrowPath.toVectorPath('NONZERO')]
  arrow.fills = [solidPaint(params.lineColor)]
  arrow.strokes = []
  frame.appendChild(arrow)
  const arrowPosition = croppedVectorPosition([edge, a, b], { x: 0, y: 0 })
  arrow.x = arrowPosition.x
  arrow.y = arrowPosition.y
  fitAngledAnnotationFrame(frame)
  for (const child of frame.children) if (child.type === 'VECTOR') child.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }
  frame.name = label
  frame.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
  frame.setPluginData(DIM_TARGET_KEY, target.id)
  return frame
}

/** Get the visual (post-transform) bounding rect of a node in its parent's
 *  local coordinate space. For unrotated/unflipped nodes this equals
 *  {x, y, width, height}. For rotated or flipped nodes it uses
 *  absoluteBoundingBox of both the node and its parent to derive the
 *  parent-relative visual bounds — so dimensions align with what the user sees.
 *  When the parent itself is rotated the simple abs-minus-abs subtraction
 *  breaks, but since dimension frames are appended as siblings of the target
 *  inside the same parent, this is the correct coordinate space for placement. */
function visualBoundsInParent(node: SceneNode): { x: number; y: number; w: number; h: number } {
  const absBB = node.absoluteBoundingBox
  if (absBB == null) return { x: node.x, y: node.y, w: node.width, h: node.height }

  const parent = node.parent
  let parentAbsX = 0
  let parentAbsY = 0
  if (parent != null && 'absoluteBoundingBox' in parent) {
    const pbb = (parent as SceneNode).absoluteBoundingBox
    if (pbb != null) {
      parentAbsX = pbb.x
      parentAbsY = pbb.y
    }
  }
  return {
    x: absBB.x - parentAbsX,
    y: absBB.y - parentAbsY,
    w: absBB.width,
    h: absBB.height,
  }
}

/** Whether a node has a non-trivial transform (rotation or flip). */
function isTransformed(node: SceneNode): boolean {
  if ('rotation' in node && typeof node.rotation === 'number' && Math.abs(node.rotation) > 0.01) return true
  // Check for flips via relativeTransform scale components
  if ('relativeTransform' in node) {
    const t = node.relativeTransform
    if (t != null) {
      // A flip shows as negative scale on one axis
      if (t[0][0] < 0 || t[1][1] < 0) return true
    }
  }
  return false
}

function annotationTransform(transform: Transform, localX: number, localY: number): Transform {
  return [
    [transform[0][0], transform[0][1], transform[0][2] + transform[0][0] * localX + transform[0][1] * localY],
    [transform[1][0], transform[1][1], transform[1][2] + transform[1][0] * localX + transform[1][1] * localY],
  ]
}

async function buildDimensions(
  target: SceneNode,
  params: Params,
  resolvedSides?: { widthSide: 'top' | 'bottom'; heightSide: 'left' | 'right' },
): Promise<SceneNode[]> {
  if (target.removed) return []
  await ensureFont({ family: params.fontFamily, style: 'Regular' })
  if (target.removed) return []

  if (target.type === 'ELLIPSE' && circularRadius(target) != null) {
    const radiusDim = await createRadiusDimension(target, params)
    return radiusDim == null ? [] : [radiusDim]
  }

  const parent = target.parent
  const canAppend = parent != null && 'appendChild' in parent

  // Measure in the shape's local coordinate system, then transform the entire
  // annotation into its parent. Rotation must not inflate the measured size.
  const rW = target.width
  const rH = target.height

  const fontPaint = solidPaint(params.fontColor)
  const linePaint = solidPaint(params.lineColor)
  const nodes: SceneNode[] = []

  const { widthSide, heightSide } = resolvedSides ?? placementToSides(params.placement, target, params)

  if (params.showWidth) {
    const meta: DimMeta = { axis: 'h', side: widthSide, scale: params.scale, units: params.units, decimals: params.decimals }
    const dim = await createHDimFrame(rW, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, widthSide, params.endpointStyle)
    dim.setPluginData(DIM_TARGET_KEY, target.id)
    if (canAppend) (parent as FrameNode).appendChild(dim)
    if (parent != null && 'layoutMode' in parent && parent.layoutMode !== 'NONE') dim.layoutPositioning = 'ABSOLUTE'
    meta.localX = 0
    meta.localY = widthSide === 'bottom' ? rH : -dim.height
    dim.relativeTransform = annotationTransform(target.relativeTransform, meta.localX, meta.localY)
    dim.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
    nodes.push(dim)
  }

  if (params.showHeight) {
    const meta: DimMeta = { axis: 'v', side: heightSide, scale: params.scale, units: params.units, decimals: params.decimals }
    const dim = await createVDimFrame(rH, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, heightSide, params.endpointStyle)
    dim.setPluginData(DIM_TARGET_KEY, target.id)
    if (canAppend) (parent as FrameNode).appendChild(dim)
    if (parent != null && 'layoutMode' in parent && parent.layoutMode !== 'NONE') dim.layoutPositioning = 'ABSOLUTE'
    meta.localX = heightSide === 'right' ? rW : -dim.width
    meta.localY = 0
    dim.relativeTransform = annotationTransform(target.relativeTransform, meta.localX, meta.localY)
    dim.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
    nodes.push(dim)
  }

  return nodes
}

// Permanent annotations are static. Ownership is only for explicit replacement;
// the observer records annotation-local moves and updates labels on own resize.
interface AnnotationState {
  parent: string; transform: Transform; width: number; height: number
  vector?: Point2; measurement?: { vector: Point2; value: number }; pending?: boolean
  group?: { raw: Transform; peerId: string; peer: Point2 }
}
const annotationRevisions = new Map<string, number>()
const pendingLabels = new Map<string, number>()
const pendingUpgrades = new Set<string>()
const failedUpgrades = new Map<string, string>()
let annotationSession = 0

function sameTransform(a: Transform, b: Transform): boolean {
  return a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) <= (j === 2 ? 1e-4 : 1e-7)))
}

function pageSceneNodes(page: PageNode): SceneNode[] {
  return page.findAllWithCriteria({ types: ['FRAME', 'COMPONENT', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'VECTOR',
    'INSTANCE', 'POLYGON', 'STAR', 'LINE', 'TEXT', 'BOOLEAN_OPERATION', 'SECTION', 'SLICE'] })
}

function detachDimension(dim: SceneNode, meta: DimMeta): void {
  meta.mode = 'freeform'
  delete meta.gapPair
  delete meta.localX
  delete meta.localY
  dim.setPluginData(DIM_TARGET_KEY, '')
  dim.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
}


function annotationState(dim: FrameNode | ComponentNode): AnnotationState {
  const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
  let vector: Point2 | undefined
  if (meta.axis === 'a' || meta.axis === 'r') {
    const geometry = dim.children.find(n => n.name === (meta.axis === 'a' ? 'angled-dimension-lines' : 'radius-leader'))
    const arrow = dim.children.find(n => n.name === 'radius-arrow')
    if (geometry?.type === 'VECTOR') {
      try {
        const points = meta.axis === 'a' ? legacyLinearGeometry(dim).line : annotationPath(geometry)
        const edge = meta.axis === 'a' ? points[1] : arrow?.type === 'VECTOR' ? annotationPath(arrow)[0] : undefined
        if (edge != null) vector = { x: edge.x - points[0].x, y: edge.y - points[0].y }
      } catch {
        if (meta.axis !== 'a') throw new Error('Unsupported radius geometry')
        // Pose tracking must still protect a moved legacy annotation when geometry is ambiguous.
      }
    }
  }
  let transform = dim.relativeTransform
  let group: AnnotationState['group']
  if (dim.parent?.type === 'GROUP') {
    // Group children use containing-frame coordinates. Normalize into the actual
    // group's space so moving that group is not an annotation-only drag.
    const p = dim.parent.absoluteTransform, t = dim.absoluteTransform
    const [a, c, x] = p[0], [b, d, y] = p[1], det = a * d - b * c
    if (Math.abs(det) <= 1e-12) throw new Error('Singular annotation parent')
    transform = [[(d * t[0][0] - c * t[1][0]) / det, (d * t[0][1] - c * t[1][1]) / det, (d * (t[0][2] - x) - c * (t[1][2] - y)) / det],
      [(-b * t[0][0] + a * t[1][0]) / det, (-b * t[0][1] + a * t[1][1]) / det, (-b * (t[0][2] - x) + a * (t[1][2] - y)) / det]]
    const peer = dim.parent.children.find(n => n !== dim)
    if (peer != null) {
      const q = peer.absoluteTransform
      group = { raw: dim.relativeTransform, peerId: peer.id,
        peer: { x: (d * (q[0][2] - x) - c * (q[1][2] - y)) / det, y: (-b * (q[0][2] - x) + a * (q[1][2] - y)) / det } }
    }
  }
  return { parent: dim.parent?.id ?? '', transform, width: dim.width, height: dim.height, vector, group }
}

/** Baseline only completed plugin writes; target geometry is never recorded. */
function rememberAnnotations(dims: readonly SceneNode[]): void {
  for (const dim of dims) {
    if ((dim.type !== 'FRAME' && dim.type !== 'COMPONENT') || dim.removed || !isDimFrame(dim)) continue
    const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
    // Native constraints scale artwork once on resize; K already scales children.
    if (meta.axis === 'r') for (const child of dim.children) {
      if (child.type === 'VECTOR') child.constraints = { horizontal: 'SCALE', vertical: 'SCALE' }
    }
    const state = annotationState(dim)
    if (state.vector != null) state.measurement = { vector: state.vector, value: meta.axis === 'a' ? Math.hypot(state.vector.x, state.vector.y) : meta.measuredSpan ?? Math.hypot(state.vector.x, state.vector.y) }
    dim.setPluginData(ANNOTATION_STATE_KEY, JSON.stringify(state))
    annotationRevisions.set(dim.id, (annotationRevisions.get(dim.id) ?? 0) + 1)
  }
}

function setNaturalLabelSizing(text: TextNode): void {
  // Native resize can switch auto-width text to HEIGHT with a stale, wrapping width.
  text.textTruncation = 'DISABLED'
  text.maxLines = null
  text.textAutoResize = 'WIDTH_AND_HEIGHT'
}

function reflowAnnotationText(dim: FrameNode | ComponentNode, text: TextNode, meta: DimMeta, label?: string): void {
  const t = text.relativeTransform, oldWidth = text.width
  let leftSide = false
  if (meta.axis === 'r') {
    const leader = dim.children.find(n => n.name === 'radius-leader')
    if (leader?.type !== 'VECTOR') throw new Error('Missing radius leader')
    const points = annotationPath(leader)
    if (points.length < 3) throw new Error('Unsupported radius leader')
    leftSide = points[2].x < points[1].x
  }
  setNaturalLabelSizing(text)
  if (label != null) text.characters = label
  // Keep the normal-axis top anchor, not the old wrapped box's center.
  const next: Transform = [[...t[0]], [...t[1]]]
  if (meta.axis === 'h') next[0][2] += dim.width / 2 - (t[0][2] + t[0][0] * text.width / 2 + t[0][1] * text.height / 2)
  else if (meta.axis === 'v') next[1][2] += dim.height / 2 - (t[1][2] + t[1][0] * text.width / 2 + t[1][1] * text.height / 2)
  else if (leftSide) {
    next[0][2] += t[0][0] * (oldWidth - text.width)
    next[1][2] += t[1][0] * (oldWidth - text.width)
  }
  text.relativeTransform = next
}

function writeAnnotationLabel(dim: FrameNode | ComponentNode): void {
  const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
  const state = annotationState(dim)
  const previous = JSON.parse(dim.getPluginData(ANNOTATION_STATE_KEY)) as AnnotationState
  const text = dim.children.find(n => n.type === 'TEXT' && n.name === 'dim-text') as TextNode | undefined
  if (text == null) return
  let span = meta.axis === 'h' ? dim.width : dim.height
  if (meta.axis === 'a') return // Legacy lines must be upgraded, never ratio-scaled from an old slash baseline.
  if (meta.edgeLinear) meta.measuredSpan = span
  if (state.vector != null) {
    const reference = previous.measurement
    span = reference == null ? meta.measuredSpan ?? Math.hypot(state.vector.x, state.vector.y)
      : reference.value * Math.hypot(state.vector.x, state.vector.y) / Math.hypot(reference.vector.x, reference.vector.y)
    if (!Number.isFinite(span)) return
    meta.measuredSpan = span
  }
  reflowAnnotationText(dim, text, meta, formatDimValue(span, meta))
  dim.name = text.characters
  dim.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
  rememberAnnotations([dim])
}

async function updateAnnotationLabel(dim: FrameNode | ComponentNode, revision: number, page: PageNode, normalizeOnly = false): Promise<void> {
  if (pendingLabels.get(dim.id) === revision) return
  pendingLabels.set(dim.id, revision)
  const session = annotationSession
  const snapshot = JSON.stringify(annotationState(dim))
  try {
    const text = dim.children.find(n => n.type === 'TEXT' && n.name === 'dim-text') as TextNode | undefined
    if (text == null) return
    const textSnapshot = () => JSON.stringify([text.characters, text.relativeTransform, text.width, text.height,
      text.fontName, text.fontSize, text.lineHeight, text.letterSpacing, text.textAutoResize, text.textTruncation, text.maxLines])
    const before = textSnapshot()
    const fonts = typeof text.fontName === 'object' ? [text.fontName] : text.getRangeAllFontNames(0, text.characters.length)
    for (const font of fonts) await ensureFont(font)
    if (pluginClosed || isExecuting || session !== annotationSession || figma.currentPage !== page || annotationRevisions.get(dim.id) !== revision
      || dim.removed || text.removed || !canRestyleDimension(dim, page) || JSON.stringify(annotationState(dim)) !== snapshot || textSnapshot() !== before) return
    if (normalizeOnly) reflowAnnotationText(dim, text, JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta)
    else writeAnnotationLabel(dim)
  } catch { /* Unavailable fonts/legacy geometry leave the current label intact. */ }
  finally { if (session === annotationSession && pendingLabels.get(dim.id) === revision) pendingLabels.delete(dim.id) }
}

/** Own local pose, not target drift, decides explicit replacement eligibility. */
function reconcileAnnotations(): void {
  if (pluginClosed) return
  const page = figma.currentPage
  let nodes: SceneNode[]
  try { nodes = pageSceneNodes(page) } catch { return }
  const byId = new Map(nodes.map(n => [n.id, n]))
  for (const dim of nodes) {
    if ((dim.type !== 'FRAME' && dim.type !== 'COMPONENT') || !isDimFrame(dim)
      || isSelectionBadgeNode(dim) || !canRestyleDimension(dim, page)) continue
    try {
      const raw = dim.getPluginData(ANNOTATION_STATE_KEY)
      if (!raw) {
        rememberAnnotations([dim]) // No evidence of historic edits: keep the current pose.
        if ((JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta).axis === 'a') void upgradeLegacyDimension(dim, page)
      }
      if (!annotationRevisions.has(dim.id)) annotationRevisions.set(dim.id, 0)
      const previous = JSON.parse(raw || dim.getPluginData(ANNOTATION_STATE_KEY)) as AnnotationState, now = annotationState(dim)
      const poseChanged = previous.parent !== now.parent || !sameTransform(previous.transform, now.transform)
      let moved = poseChanged, groupChanged = false
      if (previous.parent === now.parent && previous.group != null && now.group != null) {
        const rawMoved = !sameTransform(previous.group.raw, now.group.raw)
        const peerMoved = previous.group.peerId !== now.group.peerId
          || Math.hypot(previous.group.peer.x - now.group.peer.x, previous.group.peer.y - now.group.peer.y) > 1e-4
        // Group bounds may shift when another child moves. Require an actual
        // annotation move, and distinguish moving the whole group from one child.
        moved = rawMoved && (poseChanged || peerMoved)
        groupChanged = rawMoved || peerMoved
      }
      const resized = Math.abs(previous.width - now.width) > 1e-4 || Math.abs(previous.height - now.height) > 1e-4
        || JSON.stringify(previous.vector) !== JSON.stringify(now.vector)
      const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
      const ids = meta.gapPair ?? [dim.getPluginData(DIM_TARGET_KEY)].filter(Boolean)
      const groupedTogether = previous.parent !== now.parent && dim.parent?.type === 'GROUP'
        && dim.parent.parent?.id === previous.parent && ids.length > 0 && ids.every(id => byId.get(id)?.parent === dim.parent)
      if (moved && !groupedTogether && meta.mode !== 'freeform') detachDimension(dim, meta)
      if (poseChanged || groupChanged || resized) {
        dim.setPluginData(ANNOTATION_STATE_KEY, JSON.stringify({ ...now, measurement: previous.measurement, pending: resized || previous.pending }))
        annotationRevisions.set(dim.id, (annotationRevisions.get(dim.id) ?? 0) + 1)
      }
      if (meta.axis === 'a') { if (!isExecuting) void upgradeLegacyDimension(dim, page) }
      else if (!isExecuting && (resized || previous.pending)) void updateAnnotationLabel(dim, annotationRevisions.get(dim.id) ?? 0, page)
      else if (!isExecuting && ['h', 'v', 'r'].includes(meta.axis)) {
        const text = dim.children.find(n => n.type === 'TEXT' && n.name === 'dim-text') as TextNode | undefined
        if (text != null && (text.textAutoResize !== 'WIDTH_AND_HEIGHT' || text.textTruncation !== 'DISABLED' || text.maxLines != null)) {
          void updateAnnotationLabel(dim, annotationRevisions.get(dim.id) ?? 0, page, true)
        }
      }
    } catch {
      try {
        if ((JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta).axis === 'a') void upgradeLegacyDimension(dim, page)
      } catch { /* Unsupported annotations remain untouched. */ }
    }
  }
}

function affectsSelectionBadge(node: BaseNode): boolean {
  let target: BaseNode | null = selectionBadgeTarget
  while (target != null) {
    if (target.id === node.id) return true
    target = target.parent
  }
  return false
}

function onAutoRefresh(event: NodeChangeEvent): void {
    if (pluginClosed) return
    let relevant = event.nodeChanges.some(change => change.type !== 'PROPERTY_CHANGE')
    for (const change of event.nodeChanges) {
      if (change.type !== 'PROPERTY_CHANGE') continue
      const props = change.properties as string[]
      const changesGeometry = props.includes('width') || props.includes('height') || props.includes('x') || props.includes('y') || props.includes('relativeTransform') || props.includes('arcData') || props.includes('rotation') || props.includes('parent')
      if (!changesGeometry && !props.includes('vectorNetwork') && !props.includes('layoutMode') && !props.includes('itemSpacing')) continue

      const node = change.node
      if (node.removed || isSelectionBadgeNode(node)) continue
      relevant = true
      if (selectionBadgeTarget != null && affectsSelectionBadge(node)) {
        queueSelectionBadgeUpdate(selectionBadgeTarget)
      }
    }
    if (relevant) reconcileAnnotations()
}

function setupAutoRefresh(): void {
  const page = figma.currentPage
  if (autoRefreshPage === page) return
  if (autoRefreshPage != null && !autoRefreshPage.removed) autoRefreshPage.off('nodechange', onAutoRefresh)
  autoRefreshPage = page
  selectionBadgePages.add(page)
  page.on('nodechange', onAutoRefresh)
  annotationSession += 1
  annotationRevisions.clear()
  pendingLabels.clear()
  reconcileAnnotations()
}

function onCurrentPageChange(): void {
  if (pluginClosed) return
  removeSelectionBadge()
  if (autoRefreshPage != null) removeStaleSelectionBadges(null, autoRefreshPage)
  setupAutoRefresh()
  refreshSelection()
}

// ── Action infrastructure ─────────────────────────────────────────────

function uniqueSceneNodes(nodes: readonly SceneNode[]): SceneNode[] {
  return [...new Set(nodes)].filter((node) => !node.removed)
}

function attachRelaunch(nodes: readonly SceneNode[]): void {
  const unique = uniqueSceneNodes(nodes)
  if (unique.length > 0) {
    for (const node of unique) node.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
  } else {
    figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
  }
}

/** Check if a node is a dimension frame/group created by this plugin */
function isDimFrame(node: SceneNode): boolean {
  if (node.removed) return false
  if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'GROUP') return false
  try {
    return node.getPluginData(DIM_DATA_KEY).length > 0
  } catch { return false }
}

/** Find owned dimensions on this page, even while a target is being reparented. */
function findSiblingDims(target: SceneNode): SceneNode[] {
  if (target.removed) return []
  const page = figma.currentPage
  return pageSceneNodes(page).filter(c => {
    if (c.id === target.id || c.removed || !isDimFrame(c)) return false
    if (!canRestyleDimension(c, page)) return false
    // Only match dims that belong to this specific target
    try {
      const storedTargetId = c.getPluginData(DIM_TARGET_KEY)
      const meta = JSON.parse(c.getPluginData(DIM_DATA_KEY)) as DimMeta
      return meta.mode !== 'freeform' && storedTargetId === target.id
    } catch { return false }
  })
}

/** Resolve the actual measurement target from a selection node.
 *  If the user selected a dimension frame itself, find what it annotates
 *  using the stored target ID. Standalone dimensions never infer a target.
 *  Returns null if no valid target can be found. */
function resolveTarget(node: SceneNode): SceneNode | null {
  if (node.removed || isSelectionBadgeNode(node)) return null
  if (!isDimFrame(node)) return node
  // Pair annotations have no single target; do not resolve a random sibling.
  try {
    const meta = JSON.parse(node.getPluginData(DIM_DATA_KEY)) as DimMeta
    if (meta.mode === 'freeform' || meta.gapPair != null) return null
  } catch { return null }
  // Try to resolve via stored target ID first
  try {
    const storedTargetId = node.getPluginData(DIM_TARGET_KEY)
    if (storedTargetId.length > 0) {
      if (node.removed) return null
      const found = pageSceneNodes(figma.currentPage).find(c => c.id === storedTargetId && !c.removed && !isSelectionBadgeNode(c))
      if (found) return found
    }
  } catch { /* fall through */ }
  // No sibling inference: missing ownership is standalone, not an invitation to reconnect.
  return null
}

function dimensionSlot(dim: SceneNode, target: SceneNode): string | null {
  try {
    const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as Partial<DimMeta>
    if (meta.perimeterEdge != null) return 'a:edge:' + meta.perimeterEdge
    if (meta.axis === 'a' || meta.edgeLinear) return 'a:longest'
    if (meta.axis === 'r') return 'r:radius'
    if (meta.axis !== 'h' && meta.axis !== 'v') return null
    if (meta.axis === 'h') {
      const side = meta.side === 'top' || meta.side === 'bottom'
        ? meta.side
        : (dim.y + dim.height / 2 < target.y + target.height / 2 ? 'top' : 'bottom')
      return 'h:' + side
    }
    const side = meta.side === 'left' || meta.side === 'right'
      ? meta.side
      : (dim.x + dim.width / 2 < target.x + target.width / 2 ? 'left' : 'right')
    return 'v:' + side
  } catch {
    return null
  }
}

/** Replace only annotations that occupy the same requested axis and side. */
function removeDimensionsAtSlots(target: SceneNode, slots: ReadonlySet<string>): void {
  if (target.removed) return
  const dims = findSiblingDims(target)
  for (const d of dims) {
    if (!d.removed && slots.has(dimensionSlot(d, target) ?? '')) d.remove()
  }
}

function replacementSlots(
  placement: Placement,
  showWidth: boolean,
  showHeight: boolean,
  sides: DimensionSides,
): Set<string> {
  const slots = new Set<string>()
  if (showWidth) {
    if (placement === 'auto') {
      slots.add('h:top')
      slots.add('h:bottom')
    } else {
      slots.add('h:' + sides.widthSide)
    }
  }
  if (showHeight) {
    if (placement === 'auto') {
      slots.add('v:left')
      slots.add('v:right')
    } else {
      slots.add('v:' + sides.heightSide)
    }
  }
  return slots
}

function status_add_dimensions(selection: readonly SceneNode[]): string {
  if (selection.length === 0) return 'Annotate selected layers'
  if (selection.length === 1) return 'Annotate ' + selection[0].name
  return 'Annotate ' + selection.length + ' layers'
}
function evaluateEnabled_add_dimensions(_selection: readonly SceneNode[]): boolean {
  return true
}
// ── Gap / spacing annotation ──────────────────────────────────────────

interface VisualRect { x: number; y: number; w: number; h: number }
interface ResolvedTarget { node: SceneNode; rect: VisualRect }

function shouldAnnotateGap(gap: number, params: Params): boolean {
  // Ignore geometric residue and gaps whose configured label would be zero.
  return Number.isFinite(gap) && gap > 0.0001
    && Number(formatMeasurement(gap * params.scale, params.decimals)) > 0
}

/** Get visual bounds for a node in its parent's coordinate space. */
function nodeRect(node: SceneNode): VisualRect {
  if (isTransformed(node)) return visualBoundsInParent(node)
  return { x: node.x, y: node.y, w: node.width, h: node.height }
}

function shareVerticalSpan(targets: readonly ResolvedTarget[]): boolean {
  if (targets.length < 2) return false
  const first = targets[0].rect
  return targets.every(({ rect }) => Math.abs(rect.y - first.y) <= 0.5 && Math.abs(rect.h - first.h) <= 0.5)
}

function boundsOfTargets(targets: readonly ResolvedTarget[]): VisualRect | null {
  if (targets.length === 0) return null
  const left = Math.min(...targets.map(({ rect }) => rect.x))
  const top = Math.min(...targets.map(({ rect }) => rect.y))
  const right = Math.max(...targets.map(({ rect }) => rect.x + rect.w))
  const bottom = Math.max(...targets.map(({ rect }) => rect.y + rect.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function outwardPlacement(rect: VisualRect, bounds: VisualRect, fallback: DimensionSides): DimensionSides {
  const horizontalDelta = rect.x + rect.w / 2 - (bounds.x + bounds.w / 2)
  const verticalDelta = rect.y + rect.h / 2 - (bounds.y + bounds.h / 2)
  return {
    widthSide: verticalDelta < -0.5 ? 'top' : verticalDelta > 0.5 ? 'bottom' : fallback.widthSide,
    heightSide: horizontalDelta < -0.5 ? 'left' : horizontalDelta > 0.5 ? 'right' : fallback.heightSide,
  }
}

/** Auto-only touching rectangle stacks; values/labels never establish sharing. */
function sharedHorizontalDimensions(targets: readonly ResolvedTarget[], params: Params): Map<string, string> {
  const owners = new Map<string, string>()
  if (params.placement !== 'auto' || !params.showWidth) return owners
  const groups = new Map<string, ResolvedTarget[]>()
  for (const target of targets) {
    const { node, rect } = target
    if (node.parent == null || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) continue
    const t = node.relativeTransform
    // Relative rotations, flips, scales and shears fall back to existing placement.
    if (!t.every(row => row.every(Number.isFinite)) || Math.abs(t[0][0] - 1) > 1e-7 || Math.abs(t[1][1] - 1) > 1e-7
      || Math.abs(t[0][1]) > 1e-7 || Math.abs(t[1][0]) > 1e-7) continue
    if (node.type === 'VECTOR') {
      const boundary = straightPolygonVertices(node.vectorNetwork)
      if (boundary == null || boundary.length !== 4 || !boundary.every(p =>
        (p.x === 0 || p.x === node.width) && (p.y === 0 || p.y === node.height))) continue
    } else if (node.type !== 'RECTANGLE') continue
    const key = JSON.stringify([node.parent.id, rect.x, rect.w])
    const group = groups.get(key) ?? []
    group.push(target)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.rect.y - b.rect.y)
    // Ambiguous overlapping intervals are not a stack, even if some edges touch.
    if (group.some((target, i) => i > 0 && target.rect.y < group[i - 1].rect.y + group[i - 1].rect.h - 1e-7)) continue
    let start = 0
    for (let end = 1; end <= group.length; end++) {
      if (end < group.length && Math.abs(group[end].rect.y - group[end - 1].rect.y - group[end - 1].rect.h) <= 1e-7) continue
      if (end - start >= 2) {
        const owner = group[end - 1].node.id
        for (let i = start; i < end; i++) owners.set(group[i].node.id, owner)
      }
      start = end
    }
  }
  return owners
}

function sharedVerticalDimension(
  targets: readonly ResolvedTarget[],
  params: Params,
): { targetId: string; side: 'left' | 'right' } | null {
  if (targets.some(({ node }) => circularRadius(node) != null || (perimeterEdgesForNode(node)?.length ?? 0) > 0)) return null
  if (params.placement !== 'auto' || !params.showHeight || !shareVerticalSpan(targets)) return null
  const parent = targets[0].node.parent
  if (parent == null || targets.some(({ node }) => node.parent?.id !== parent.id)) return null

  const leftTarget = targets.reduce((best, candidate) => candidate.rect.x < best.rect.x ? candidate : best)
  const rightTarget = targets.reduce((best, candidate) => candidate.rect.x + candidate.rect.w > best.rect.x + best.rect.w ? candidate : best)
  const leftClear = availableClearance(leftTarget.node, 'left')
  const rightClear = availableClearance(rightTarget.node, 'right')
  const annotationDepth = params.offset + params.fontSize + 10

  if (rightClear >= annotationDepth && leftClear < annotationDepth) return { targetId: rightTarget.node.id, side: 'right' }
  if (leftClear >= annotationDepth && rightClear < annotationDepth) return { targetId: leftTarget.node.id, side: 'left' }
  return rightClear >= leftClear
    ? { targetId: rightTarget.node.id, side: 'right' }
    : { targetId: leftTarget.node.id, side: 'left' }
}

/** Remove extension lines from a dimension frame by name.
 *  This prevents double-line artifacts where a gap dim's extension line
 *  would sit right next to a layer dim's extension line at the same edge. */
function removeExtensionLines(dimFrame: FrameNode, names: string[]): void {
  const nameSet = new Set(names)
  for (const child of [...dimFrame.children]) {
    if (nameSet.has(child.name) && !child.removed) child.remove()
  }
}

function sameDimensionTrack(axis: 'h' | 'v', first: VisualRect, second: VisualRect, tolerance = 1): boolean {
  return axis === 'h'
    ? Math.abs(first.y - second.y) <= tolerance
    : Math.abs(first.x - second.x) <= tolerance
}

/** Remove duplicate extension lines where adjacent layer dimension frames share
 *  an edge (i.e. the layers are touching with no gap).
 *  For horizontal dims: sort by x, and where one dim's right edge meets the next
 *  dim's left edge, remove ext-r from the left dim and ext-l from the right dim.
 *  For vertical dims: sort by y, remove ext-b from top dim and ext-t from bottom dim. */
function deduplicateLayerDimExtensions(dimFrames: SceneNode[]): void {
  const TOLERANCE = 1  // pixel tolerance for "same edge"

  // Parse dim metadata
  const parsed: { frame: FrameNode; axis: 'h' | 'v'; side: string }[] = []
  for (const f of dimFrames) {
    if (f.removed || f.type !== 'FRAME') continue
    // Axis-aligned shared-edge rules do not apply to rotated annotations.
    if (Math.abs(f.rotation) > 0.01) continue
    try {
      const meta = JSON.parse(f.getPluginData(DIM_DATA_KEY)) as Partial<DimMeta>
      if (!meta.edgeLinear && (meta.axis === 'h' || meta.axis === 'v')) {
        parsed.push({ frame: f as FrameNode, axis: meta.axis, side: String(meta.side) })
      }
    } catch { /* skip */ }
  }

  // Group horizontal dims by side (top/bottom)
  const hByGroupKey = new Map<string, { frame: FrameNode }[]>()
  const vByGroupKey = new Map<string, { frame: FrameNode }[]>()
  for (const p of parsed) {
    const map = p.axis === 'h' ? hByGroupKey : vByGroupKey
    const key = p.frame.parent?.id + ':' + p.side
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push({ frame: p.frame })
  }

  // Horizontal dims: sort by x, check right-edge-meets-left-edge
  // Keep the right dim's ext-l, remove only the left dim's ext-r
  for (const group of hByGroupKey.values()) {
    group.sort((a, b) => a.frame.x - b.frame.x)
    for (let i = 0; i < group.length - 1; i++) {
      const left = group[i].frame
      const right = group[i + 1].frame
      const leftRightEdge = left.x + left.width
      const rightLeftEdge = right.x
      if (
        Math.abs(leftRightEdge - rightLeftEdge) <= TOLERANCE
        && sameDimensionTrack('h', nodeRect(left), nodeRect(right), TOLERANCE)
      ) {
        removeExtensionLines(left, ['ext-r'])
      }
    }
  }

  // Vertical dims: sort by y, check bottom-edge-meets-top-edge
  // Keep the bottom dim's ext-t, remove only the top dim's ext-b
  for (const group of vByGroupKey.values()) {
    group.sort((a, b) => a.frame.y - b.frame.y)
    for (let i = 0; i < group.length - 1; i++) {
      const top = group[i].frame
      const bottom = group[i + 1].frame
      const topBottomEdge = top.y + top.height
      const bottomTopEdge = bottom.y
      if (
        Math.abs(topBottomEdge - bottomTopEdge) <= TOLERANCE
        && sameDimensionTrack('v', nodeRect(top), nodeRect(bottom), TOLERANCE)
      ) {
        removeExtensionLines(top, ['ext-b'])
      }
    }
  }
}

function extendGapWitnesses(frame: FrameNode | ComponentNode, meta: DimMeta): void {
  if (meta.gapExtensions == null) return
  const horizontal = meta.axis === 'h'
  const near = meta.side === 'top' || meta.side === 'left'
  const names = horizontal ? ['ext-l', 'ext-r'] : ['ext-t', 'ext-b']
  names.forEach((name, index) => {
    const line = frame.children.find(child => child.name === name)
    const extra = meta.gapExtensions![index] ?? 0
    if (line?.type !== 'LINE' || !Number.isFinite(extra) || extra <= 0) return
    line.resize(line.width + extra, 0)
    if (!near) {
      if (horizontal) line.y -= extra
      else line.x -= extra
    }
  })
}

/** Build projected axis gaps in one coordinate space, including staggered pairs.
 *  Keep extensions: layer annotations need not share the same track. */
async function buildGapDimensions(
  targets: { node: SceneNode; rect: VisualRect }[],
  params: Params,
  parentNode: BaseNode & ChildrenMixin,
): Promise<SceneNode[]> {
  if (targets.length < 2) return []
  const fontPaint = solidPaint(params.fontColor)
  const linePaint = solidPaint(params.lineColor)
  const nodes: SceneNode[] = []
  const placement = params.placement

  // Horizontal gaps (width-axis spacing)
  const showHGaps = placement === 'auto' || placement === 'up' || placement === 'down'
  if (showHGaps) {
    const sorted = [...targets].sort((a, b) => a.rect.x - b.rect.x)
    for (let i = 0; i < sorted.length - 1; i++) {
      const left = sorted[i]
      const right = sorted[i + 1]
      const leftRight = left.rect.x + left.rect.w
      const rightLeft = right.rect.x
      const gap = rightLeft - leftRight
      if (!shouldAnnotateGap(gap, params)) continue

      const lTop = left.rect.y
      const lBot = left.rect.y + left.rect.h
      const rTop = right.rect.y
      const rBot = right.rect.y + right.rect.h

      const hSide: 'top' | 'bottom' = placement === 'up' ? 'top' : 'bottom'
      const meta: DimMeta = { axis: 'h', side: hSide, scale: params.scale, units: params.units, decimals: params.decimals, gapPair: [left.node.id, right.node.id].sort() }
      const dim = await createHDimFrame(gap, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, hSide, params.endpointStyle)

      parentNode.appendChild(dim)
      if ('layoutMode' in parentNode && parentNode.layoutMode !== 'NONE') dim.layoutPositioning = 'ABSOLUTE'
      dim.x = leftRight
      const overlapTop = Math.min(lTop, rTop)
      const overlapBot = Math.max(lBot, rBot)
      if (hSide === 'bottom') {
        dim.y = overlapBot
      } else {
        dim.y = overlapTop - dim.height
      }
      meta.gapExtensions = hSide === 'bottom' ? [overlapBot - lBot, overlapBot - rBot] : [lTop - overlapTop, rTop - overlapTop]
      extendGapWitnesses(dim, meta)
      dim.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
      nodes.push(dim)
    }
  }

  // Vertical gaps (height-axis spacing)
  const showVGaps = placement === 'auto' || placement === 'left' || placement === 'right'
  if (showVGaps) {
    const sorted = [...targets].sort((a, b) => a.rect.y - b.rect.y)
    for (let i = 0; i < sorted.length - 1; i++) {
      const top = sorted[i]
      const bottom = sorted[i + 1]
      const topBottom = top.rect.y + top.rect.h
      const bottomTop = bottom.rect.y
      const gap = bottomTop - topBottom
      if (!shouldAnnotateGap(gap, params)) continue

      const tLeft = top.rect.x
      const tRight = top.rect.x + top.rect.w
      const bLeft = bottom.rect.x
      const bRight = bottom.rect.x + bottom.rect.w

      const vSide: 'left' | 'right' = placement === 'left' ? 'left' : 'right'
      const meta: DimMeta = { axis: 'v', side: vSide, scale: params.scale, units: params.units, decimals: params.decimals, gapPair: [top.node.id, bottom.node.id].sort() }
      const dim = await createVDimFrame(gap, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, vSide, params.endpointStyle)

      parentNode.appendChild(dim)
      if ('layoutMode' in parentNode && parentNode.layoutMode !== 'NONE') dim.layoutPositioning = 'ABSOLUTE'
      dim.y = topBottom
      const overlapLeft = Math.min(tLeft, bLeft)
      const overlapRight = Math.max(tRight, bRight)
      if (vSide === 'right') {
        dim.x = overlapRight
      } else {
        dim.x = overlapLeft - dim.width
      }
      meta.gapExtensions = vSide === 'right' ? [overlapRight - tRight, overlapRight - bRight] : [tLeft - overlapLeft, bLeft - overlapLeft]
      extendGapWitnesses(dim, meta)
      dim.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
      nodes.push(dim)
    }
  }

  return nodes
}

// ── Main action ──────────────────────────────────────────────────────

/** Keep canvas-axis artwork intact while choosing containment independently per pair. */
function containGapDimension(dim: SceneNode, pair: readonly SceneNode[], page: PageNode): void {
  if (pair.length !== 2) return
  const shared = new Set<BaseNode>()
  for (let p = pair[1].parent; p != null && p !== page; p = p.parent) shared.add(p)
  const absolute = dim.absoluteTransform
  for (let parent = pair[0].parent; parent != null && parent !== page; parent = parent.parent) {
    if (!shared.has(parent) || !('appendChild' in parent)
      || !['FRAME', 'GROUP', 'COMPONENT', 'SECTION'].includes(parent.type)) continue
    let safe = true
    for (let p: BaseNode | null = parent; p != null && p !== page; p = p.parent) {
      if (p.removed || p.type === 'INSTANCE' || ('locked' in p && p.locked)) safe = false
    }
    if (!safe) continue
    // Group children use the containing frame/page coordinate system, not group-local coordinates.
    let coordinateParent: BaseNode | null = parent
    while (coordinateParent?.type === 'GROUP') coordinateParent = coordinateParent.parent
    const t: Transform = coordinateParent != null && 'absoluteTransform' in coordinateParent
      ? coordinateParent.absoluteTransform as Transform : [[1, 0, 0], [0, 1, 0]]
    const [a, c, x] = t[0], [b, d, y] = t[1]
    const det = a * d - b * c
    const norm = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d))
    if (!t.every(row => row.every(Number.isFinite)) || norm === 0
      || Math.abs(det) <= 1e-12 * norm * norm) continue
    const inverse: Transform = [[d / det, -c / det, (c * y - d * x) / det],
      [-b / det, a / det, (b * x - a * y) / det]]
    const relative: Transform = [[0, 0, 0], [0, 0, 0]]
    for (const i of [0, 1]) for (const j of [0, 1, 2]) {
      relative[i][j] = inverse[i][0] * absolute[0][j] + inverse[i][1] * absolute[1][j]
        + (j === 2 ? inverse[i][2] : 0)
    }
    if (!relative.every(row => row.every(Number.isFinite))) continue
    try {
      parent.appendChild(dim)
      if ('layoutMode' in parent && parent.layoutMode !== 'NONE' && 'layoutPositioning' in dim) dim.layoutPositioning = 'ABSOLUTE'
      dim.relativeTransform = relative
      // Some hosts normalize unsupported scale/skew. Never silently distort a measurement.
      const actual = dim.absoluteTransform
      if (actual.every((row, i) => row.every((v, j) => Number.isFinite(v)
        && Math.abs(v - absolute[i][j]) <= (j === 2 ? 1e-5 : 1e-8)))) return
    } catch { /* Try the next editable shared ancestor without changing the artwork. */ }
    page.appendChild(dim)
    dim.relativeTransform = absolute
  }
}

async function replaceGapDimensions(targets: readonly ResolvedTarget[], params: Params): Promise<SceneNode[]> {
  reconcileAnnotations()
  const page = figma.currentPage
  const ids = new Set(targets.map(({ node }) => node.id))
  const slots = replacementSlots(params.placement,
    params.placement === 'auto' || params.placement === 'up' || params.placement === 'down',
    params.placement === 'auto' || params.placement === 'left' || params.placement === 'right',
    { widthSide: params.placement === 'up' ? 'top' : 'bottom', heightSide: params.placement === 'left' ? 'left' : 'right' })
  const previous = page.findAllWithCriteria({ types: ['FRAME'] }).filter(dim => {
    try {
      const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
      return meta.mode !== 'freeform' && meta.gapPair?.length === 2 && meta.gapPair.every(id => ids.has(id))
        && slots.has(meta.axis + ':' + meta.side) && canRestyleDimension(dim, page)
    } catch { return false }
  })
  // Measure once in canvas space; containment must not transform an AABB twice.
  const canvasTargets: ResolvedTarget[] = []
  for (const { node } of targets) {
    const bb = node.absoluteBoundingBox
    if (bb != null && [bb.x, bb.y, bb.width, bb.height].every(Number.isFinite)) {
      canvasTargets.push({ node, rect: { x: bb.x, y: bb.y, w: bb.width, h: bb.height } })
    }
  }
  const nodes = await buildGapDimensions(canvasTargets, params, page)
  const byId = new Map(targets.map(({ node }) => [node.id, node]))
  for (const dim of nodes) {
    const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
    containGapDimension(dim, (meta.gapPair ?? []).map(id => byId.get(id)).filter((node): node is SceneNode => node != null), page)
  }
  for (const dim of previous) if (!dim.removed) dim.remove()
  rememberAnnotations(nodes)
  return nodes
}

const APPEARANCE_KEYS = ['offset', 'labelOffset', 'endpointStyle', 'strokeWeight', 'lineColor',
  'fontFamily', 'fontSize', 'fontColor', 'decimals'] as const

function withAppearance(params: Params, appearance: Params): Params {
  const result = { ...params }
  for (const key of APPEARANCE_KEYS) Object.assign(result, { [key]: appearance[key] })
  return result
}

/** Never cross an instance or locked boundary, including inside the annotation. */
function canRestyleDimension(node: SceneNode, page: PageNode): boolean {
  let ancestor: BaseNode | null = node
  while (ancestor != null && !ancestor.removed) {
    if (ancestor === page) {
      if (!('children' in node)) return false
      return node.findAll(n => n.locked || n.type === 'INSTANCE').length === 0
    }
    if (ancestor.type === 'INSTANCE' || ('locked' in ancestor && ancestor.locked)) return false
    ancestor = ancestor.parent
  }
  return false
}

/** Read our straight path in annotation-local coordinates, not from its target. */
function annotationSubpaths(node: VectorNode): Point2[][] {
  const paths: Point2[][] = []
  const t = node.relativeTransform
  for (const path of node.vectorPaths) {
    const tokens = path.data.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []
    let points: Point2[] | undefined
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i++]
      if (command === 'Z' || command === 'z') continue
      if (command !== 'M' && command !== 'L') throw new Error('Unsupported edited annotation path')
      if (command === 'M') { points = []; paths.push(points) }
      if (points == null) throw new Error('Missing annotation path start')
      const x = Number(tokens[i++]), y = Number(tokens[i++])
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid annotation path')
      points.push({ x: t[0][0] * x + t[0][1] * y + t[0][2], y: t[1][0] * x + t[1][1] * y + t[1][2] })
    }
  }
  return paths
}

function annotationPath(node: VectorNode): Point2[] {
  return ([] as Point2[]).concat(...annotationSubpaths(node))
}

/** Figma reorders subpaths. Recover a unique main line parallel to the label, not points[0:2]. */
function legacyLinearGeometry(dim: FrameNode | ComponentNode): { line: Point2[]; normal: Point2; witnesses: (Point2[] | undefined)[] } {
  const geometry = dim.children.find(n => n.name === 'angled-dimension-lines')
  const text = dim.children.find(n => n.name === 'dim-text' && n.type === 'TEXT') as TextNode | undefined
  if (geometry?.type !== 'VECTOR' || text == null) throw new Error('Missing legacy line or label')
  const paths = annotationSubpaths(geometry)
  if (paths.some(p => p.length !== 2)) throw new Error('Unsupported legacy line edits')
  const t = text.relativeTransform, tx = t[0][0], ty = t[1][0], size = Math.hypot(tx, ty)
  const candidates = paths.filter(([a, b]) => {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy)
    return length > 0.001 && Math.abs(dx * ty - dy * tx) <= length * size * 1e-5
  })
  if (candidates.length !== 1) throw new Error('Ambiguous legacy measurement line')
  let [a, b] = candidates[0]
  if (b.x < a.x - 1e-6 || (Math.abs(b.x - a.x) <= 1e-6 && b.y < a.y)) [a, b] = [b, a]
  const length = Math.hypot(b.x - a.x, b.y - a.y), dx = (b.x - a.x) / length, dy = (b.y - a.y) / length
  const center = { x: t[0][2] + t[0][0] * text.width / 2 + t[0][1] * text.height / 2,
    y: t[1][2] + t[1][0] * text.width / 2 + t[1][1] * text.height / 2 }
  const distance = -dy * (center.x - a.x) + dx * (center.y - a.y)
  if (Math.abs(distance) < 0.001) throw new Error('Ambiguous legacy outside direction')
  const normal = { x: -dy * Math.sign(distance), y: dx * Math.sign(distance) }
  const witnesses = [a, b].map(q => {
    const found = paths.filter(p => p !== candidates[0] && p.every(v => Math.abs((v.x - q.x) * dx + (v.y - q.y) * dy) < 0.001)
      && (p[0].x - q.x) * normal.x + (p[0].y - q.y) * normal.y
        !== (p[1].x - q.x) * normal.x + (p[1].y - q.y) * normal.y)
    if (found.length > 1) throw new Error('Ambiguous legacy witnesses')
    return found[0]
  })
  return { line: [a, b], normal, witnesses }
}

/** Reframe only our known artwork. Preserve the measured endpoints and old label center in parent space. */
async function upgradeLegacyDimension(dim: FrameNode | ComponentNode, page: PageNode, retry = false): Promise<boolean> {
  if (pendingUpgrades.has(dim.id)) return false
  const snapshot = () => JSON.stringify({ meta: dim.getPluginData(DIM_DATA_KEY), state: annotationState(dim),
    children: dim.children.map(n => [n.id, n.relativeTransform, n.width, n.height,
      n.type === 'VECTOR' ? [n.vectorPaths, n.strokes, n.fills, n.strokeWeight] : n.type === 'TEXT' ? [n.characters, n.fontName, n.fontSize, n.fills, n.lineHeight, n.letterSpacing] : null]) })
  let before = '', replacement: FrameNode | undefined, cancelled = false, writing = false
  const session = annotationSession
  pendingUpgrades.add(dim.id)
  try {
    const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
    if (meta.axis !== 'a') return true
    before = snapshot()
    if (!retry && failedUpgrades.get(dim.id) === before) return false
    const recovered = legacyLinearGeometry(dim)
    if (!Number.isFinite(meta.scale) || meta.scale <= 0 || !['mm', 'cm', 'm', 'in', 'ft'].includes(meta.units)
      || !Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 4
      || dim.children.some(n => !['dim-text', 'angled-dimension-lines', 'angled-dimension-arrows'].includes(n.name))) throw new Error('Unsupported legacy metadata or children')
    const text = dim.children.find(n => n.name === 'dim-text') as TextNode
    if (typeof text.fontName !== 'object' || typeof text.fontSize !== 'number') throw new Error('Mixed legacy label font')
    const geometry = dim.children.find(n => n.name === 'angled-dimension-lines') as VectorNode
    const arrows = dim.children.find(n => n.name === 'angled-dimension-arrows') as VectorNode | undefined
    if (typeof geometry.strokeWeight !== 'number') throw new Error('Mixed legacy stroke')
    await ensureFont(text.fontName)
    await ensureFont({ family: text.fontName.family, style: 'Regular' })
    if (pluginClosed || session !== annotationSession || figma.currentPage !== page || dim.removed || !canRestyleDimension(dim, page) || snapshot() !== before) { cancelled = true; return false }
    const [a, b] = recovered.line, length = Math.hypot(b.x - a.x, b.y - a.y)
    const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length, normal = recovered.normal
    const vertical = Math.abs(dx) <= 1e-8
    const side = vertical ? (normal.x < 0 ? 'left' : 'right') : (dx * normal.y - dy * normal.x < 0 ? 'top' : 'bottom')
    const starts = recovered.witnesses.map(path => path?.reduce((p, q) =>
      (p.x - a.x) * normal.x + (p.y - a.y) * normal.y < (q.x - a.x) * normal.x + (q.y - a.y) * normal.y ? p : q))
    const offset = starts.reduce((max, p, i) => p == null ? max : Math.max(max,
      (recovered.line[i].x - p.x) * normal.x + (recovered.line[i].y - p.y) * normal.y + EXT_GAP), 0) || DEFAULTS.offset
    const style: EndpointStyle = arrows == null ? 'slash' : arrows.fills !== figma.mixed && arrows.fills.length > 0 ? 'arrow' : 'line-arrow'
    const next: DimMeta = { ...meta, axis: vertical ? 'v' : 'h', side, measuredSpan: length, edgeLinear: true }
    const paint = geometry.strokes[0]
    if (geometry.strokes.length !== 1 || paint?.type !== 'SOLID' || text.fills === figma.mixed
      || text.fills.length !== 1 || text.fills[0]?.type !== 'SOLID') throw new Error('Unsupported legacy paints')
    replacement = await (vertical ? createVDimFrame : createHDimFrame)(length, next, text.fills[0], paint,
      text.fontSize, text.fontName.family, offset, DEFAULTS.labelOffset, geometry.strokeWeight, side as never, style)
    if (pluginClosed || session !== annotationSession || figma.currentPage !== page || dim.removed || !canRestyleDimension(dim, page) || snapshot() !== before) { cancelled = true; return false }
    const lineFrame = replacement.children.find(n => n.name === 'dim-line-frame')!
    const q = vertical ? { x: lineFrame.x + TICK, y: 0 } : { x: 0, y: lineFrame.y + TICK }
    const basis: Transform = vertical ? [[1, 0, a.x - q.x], [0, 1, a.y]]
      : [[dx, -dy, a.x - dx * q.x + dy * q.y], [dy, dx, a.y - dy * q.x - dx * q.y]]
    const old = dim.relativeTransform
    const transform: Transform = [[0, 0, 0], [0, 0, 0]]
    for (const i of [0, 1]) for (const j of [0, 1, 2]) transform[i][j] = old[i][0] * basis[0][j] + old[i][1] * basis[1][j] + (j === 2 ? old[i][2] : 0)
    const labelTransform = text.relativeTransform
    const local: Transform = [[0, 0, 0], [0, 0, 0]]
    for (const i of [0, 1]) for (const j of [0, 1, 2]) local[i][j] = basis[0][i] * (labelTransform[0][j] - (j === 2 ? basis[0][2] : 0))
      + basis[1][i] * (labelTransform[1][j] - (j === 2 ? basis[1][2] : 0))
    const generatedText = replacement.children.find(n => n.name === 'dim-text') as TextNode
    const originalChildren = [...dim.children], originalWidth = dim.width, originalHeight = dim.height
    const originalName = dim.name, originalLabel = text.characters, originalConstraints = text.constraints
    const originalMeta = dim.getPluginData(DIM_DATA_KEY), originalState = dim.getPluginData(ANNOTATION_STATE_KEY)
    const originalRevision = annotationRevisions.get(dim.id) ?? 0
    writing = true
    try {
      text.constraints = generatedText.constraints
      generatedText.remove()
      replacement.appendChild(text)
      text.relativeTransform = local
      const oldWidth = text.width
      setNaturalLabelSizing(text)
      text.characters = formatDimValue(length, next)
      const center = { x: local[0][2] + local[0][0] * oldWidth / 2 + local[0][1] * text.height / 2,
        y: local[1][2] + local[1][0] * oldWidth / 2 + local[1][1] * text.height / 2 }
      const position = transformedTopLeftForCenter(text.width, text.height, local, center)
      text.x = position.x; text.y = position.y
      const names = vertical ? ['ext-t', 'ext-b'] : ['ext-l', 'ext-r']
      for (const [i, name] of names.entries()) {
        const witness = replacement.children.find(n => n.name === name)!
        if (starts[i] == null) witness.remove()
        else if (witness.type === 'LINE') {
          const p = starts[i]!
          const x = basis[0][0] * (p.x - basis[0][2]) + basis[1][0] * (p.y - basis[1][2])
          const y = basis[0][1] * (p.x - basis[0][2]) + basis[1][1] * (p.y - basis[1][2])
          const end = vertical ? q.x + (side === 'left' ? -TICK : TICK) : q.y + (side === 'top' ? -TICK : TICK)
          witness.resize(Math.abs(end - (vertical ? x : y)), 0)
          witness.x = vertical ? Math.min(x, end) : x
          witness.y = vertical ? y : Math.min(y, end)
        }
      }
      const children = [...replacement.children]
      dim.resizeWithoutConstraints(replacement.width, replacement.height)
      dim.relativeTransform = transform
      for (const child of children) dim.appendChild(child)
      dim.name = text.characters
      dim.setPluginData(DIM_DATA_KEY, JSON.stringify(next))
      rememberAnnotations([dim]) // Completed migration is our write, not an independent drag.
    } catch (error) {
      // Keep original geometry until commit succeeds, so a rejected host write can roll back.
      for (const child of [...dim.children]) if (!originalChildren.includes(child)) child.remove()
      dim.resizeWithoutConstraints(originalWidth, originalHeight)
      dim.relativeTransform = old
      for (const child of originalChildren) dim.appendChild(child)
      setNaturalLabelSizing(text)
      text.characters = originalLabel
      text.relativeTransform = labelTransform
      text.constraints = originalConstraints
      dim.name = originalName
      dim.setPluginData(DIM_DATA_KEY, originalMeta)
      dim.setPluginData(ANNOTATION_STATE_KEY, originalState)
      annotationRevisions.set(dim.id, originalRevision)
      writing = false
      throw error
    }
    for (const child of originalChildren) if (child !== text) child.remove()
    failedUpgrades.delete(dim.id)
    return true
  } catch (error) {
    if (failedUpgrades.get(dim.id) !== before) figma.notify((writing ? 'Legacy dimension upgrade partially applied: ' : 'Legacy dimension left unchanged: ')
      + (error instanceof Error ? error.message : String(error)))
    failedUpgrades.set(dim.id, before)
    return false
  } finally {
    if (replacement != null && !replacement.removed) replacement.remove()
    pendingUpgrades.delete(dim.id)
    if (cancelled && !pluginClosed && figma.currentPage === page && !dim.removed && canRestyleDimension(dim, page)) reconcileAnnotations()
  }
}

function writeAnnotationPath(node: VectorNode, paths: Point2[][], params: Params, filled = false): void {
  const points = ([] as Point2[]).concat(...paths)
  const origin = croppedVectorPosition(points, { x: 0, y: 0 })
  const builder = new VectorPathBuilder(10)
  for (const path of paths) {
    path.forEach((point, index) => {
      if (index === 0) builder.moveTo(point.x - origin.x, point.y - origin.y)
      else builder.lineTo(point.x - origin.x, point.y - origin.y)
    })
    if (filled) builder.close()
  }
  node.vectorPaths = [builder.toVectorPath()]
  node.relativeTransform = [[1, 0, origin.x], [0, 1, origin.y]]
  node.fills = filled ? [solidPaint(params.lineColor)] : []
  node.strokes = filled ? [] : [solidPaint(params.lineColor)]
  node.strokeWeight = params.strokeWeight
  node.strokeCap = 'NONE'
  node.strokeJoin = 'MITER'
}

function restyleDimension(frame: FrameNode | ComponentNode, meta: DimMeta, params: Params): void {
  if (meta.axis === 'a') throw new Error('Legacy line needs a safe linear upgrade')
  const text = frame.children.find(n => n.name === 'dim-text' && n.type === 'TEXT') as TextNode | undefined
  if (text == null) throw new Error('Missing dimension label')
  const child = (name: string) => frame.children.find(n => n.name === name)
  const lineFrame = child('dim-line-frame')
  const geometry = child(meta.axis === 'r' ? 'radius-leader' : 'angled-dimension-lines')
  const witnesses = meta.edgeLinear ? frame.children.filter((n): n is LineNode => n.type === 'LINE' && n.name.startsWith('ext-')).map(n => {
    const horizontal = meta.axis === 'h', near = meta.side === 'top' || meta.side === 'left'
    return { node: n, x: n.x, y: n.y, start: horizontal ? n.y + (near ? n.width : 0) : n.x + (near ? n.width : 0) }
  }) : []
  let points: Point2[] = []
  let radiusEdge: Point2 | undefined
  if (meta.axis === 'r') {
    if (geometry?.type !== 'VECTOR') throw new Error('Missing annotation geometry')
    points = annotationPath(geometry)
    if (points.length < 3) throw new Error('Incomplete annotation geometry')
    if (meta.axis === 'r') {
      const arrow = child('radius-arrow')
      if (arrow?.type !== 'VECTOR') throw new Error('Missing radius arrow')
      radiusEdge = annotationPath(arrow)[0]
      if (radiusEdge == null) throw new Error('Missing radius attachment')
    }
  } else if (lineFrame?.type !== 'FRAME' || !lineFrame.children.some(n => n.name === 'dim-line')) {
    throw new Error('Unsupported linear annotation')
  }
  const geometrySpan = meta.axis === 'h' ? frame.width : meta.axis === 'v' ? frame.height
    : Math.hypot(radiusEdge!.x - points[0].x, radiusEdge!.y - points[0].y)
  const span = meta.axis === 'r' ? meta.measuredSpan ?? geometrySpan : geometrySpan
  if (!Number.isFinite(span) || span <= 0) throw new Error('Invalid measured span')
  if (geometrySpan <= 0.001) throw new Error('Invalid extension geometry')
  // All font loading and validation precedes writes; keep the root/selection intact.
  meta = { ...meta, decimals: params.decimals }
  if (meta.edgeLinear || meta.axis === 'r') meta.measuredSpan = span
  text.fontName = { family: params.fontFamily, style: 'Regular' }
  text.fontSize = params.fontSize
  text.lineHeight = { value: params.fontSize, unit: 'PIXELS' }
  setNaturalLabelSizing(text)
  text.characters = formatDimValue(span, meta)
  text.fills = [solidPaint(params.fontColor)]

  if ((meta.axis === 'h' || meta.axis === 'v') && lineFrame?.type === 'FRAME') {
    const horizontal = meta.axis === 'h'
    const near = horizontal
      ? meta.side === 'top' || (meta.side == null && lineFrame.constraints.vertical === 'MIN')
      : meta.side === 'left' || (meta.side == null && lineFrame.constraints.horizontal === 'MIN')
    const depth = horizontal ? frame.height : frame.width
    const newDepth = params.offset + params.labelOffset + text.height
    const shift = near ? depth - newDepth : 0
    if (horizontal) {
      lineFrame.resizeWithoutConstraints(span, TICK * 2)
      lineFrame.x = 0
      lineFrame.y = near ? shift + text.height + params.labelOffset - TICK : params.offset - TICK
      text.x = (span - text.width) / 2
      text.y = near ? shift : newDepth - text.height
    } else {
      lineFrame.resizeWithoutConstraints(TICK * 2, span)
      lineFrame.x = near ? shift + text.height + params.labelOffset - TICK : params.offset - TICK
      lineFrame.y = 0
      text.x = near ? shift : newDepth - text.height
      text.y = (span + text.width) / 2
    }
    if (meta.edgeLinear) {
      const center = horizontal ? { x: span / 2, y: text.y + text.height / 2 }
        : { x: text.x + text.height / 2, y: span / 2 }
      const position = transformedTopLeftForCenter(text.width, text.height, text.relativeTransform, center)
      text.x = position.x; text.y = position.y
    }
    for (const line of [...frame.children, ...lineFrame.children]) {
      if (line.type === 'LINE' && ['dim-line', 'ext-l', 'ext-r', 'ext-t', 'ext-b'].includes(line.name)) {
        line.strokes = [solidPaint(params.lineColor)]
        line.strokeWeight = params.strokeWeight
        if (line.name === 'dim-line') {
          line.resize(span, 0)
        } else if (line.name.startsWith('ext-')) {
          line.resize(params.offset + TICK - EXT_GAP, 0)
          if (horizontal) {
            line.x = line.name === 'ext-l' ? -0.5 : span - 0.5
            line.y = near ? shift + text.height + params.labelOffset - TICK : EXT_GAP
          } else {
            line.x = near ? shift + text.height + params.labelOffset - TICK : EXT_GAP
            line.y = line.name === 'ext-t' ? params.strokeWeight / 2 : span - params.strokeWeight / 2 + 1
          }
        }
      }
    }
    const inset = endpointTipInset(params.endpointStyle, params.strokeWeight)
    for (const tick of lineFrame.children) {
      if (tick.type !== 'VECTOR' || !tick.name.startsWith('tick-')) continue
      const first = tick.name === 'tick-l' || tick.name === 'tick-t'
      const direction = horizontal ? (first ? 'left' : 'right') : (first ? 'up' : 'down')
      const artwork = makeEndpoint(params.endpointStyle, solidPaint(params.lineColor), params.strokeWeight, direction)
      try {
        tick.vectorPaths = artwork.vectorPaths
        tick.fills = artwork.fills
        tick.strokes = artwork.strokes
        tick.strokeWeight = params.strokeWeight
        tick.strokeCap = 'NONE'
        tick.strokeJoin = 'MITER'
        const slash = params.endpointStyle === 'slash'
        tick.x = horizontal ? (slash ? (first ? -TICK : span - TICK) : (first ? inset : span - TICK - inset))
          : (slash ? 0 : TICK - ARROW_BASE_HALF + 0.5)
        tick.y = horizontal ? (slash ? 0 : TICK - ARROW_BASE_HALF - 0.5)
          : (slash ? (first ? -TICK : span - TICK) : (first ? inset : span - TICK - inset))
      } finally { artwork.remove() }
    }
    for (const { node, start, x, y } of witnesses) {
      const end = (horizontal ? lineFrame.y : lineFrame.x) + TICK + (near ? -TICK : TICK)
      node.resize(Math.abs(end - start), 0)
      if (horizontal) { node.y = Math.min(end, start); node.x = x }
      else { node.x = Math.min(end, start); node.y = y }
    }
  } else if (geometry?.type === 'VECTOR') {
    const center = points[0], edge = radiusEdge!
    const direction = { x: (edge.x - center.x) / geometrySpan, y: (edge.y - center.y) / geometrySpan }
    const elbow = { x: edge.x + direction.x * params.offset, y: edge.y + direction.y * params.offset }
    const sign = direction.x < 0 ? -1 : 1
    text.x = sign > 0 ? elbow.x + params.labelOffset : elbow.x - params.labelOffset - text.width
    text.y = elbow.y - params.labelOffset - text.height
    writeAnnotationPath(geometry, [[center, elbow, { x: elbow.x + sign * (params.labelOffset + text.width), y: elbow.y }]], params)
    const arrow = child('radius-arrow') as VectorNode
    arrow.fills = [solidPaint(params.lineColor)]
    if (meta.radiusParams != null) meta.radiusParams = withAppearance(meta.radiusParams, params)
  }
  extendGapWitnesses(frame, meta)
  frame.name = text.characters
  frame.setPluginData(DIM_DATA_KEY, JSON.stringify(meta))
}

async function runAction_update_appearance(params: Params): Promise<void> {
  if (pluginClosed) return
  if (isExecuting) { figma.notify('Another action is in progress. Try again when it finishes.'); return }
  const page = figma.currentPage
  isExecuting = true
  let updated = 0, skipped = 0, failed = 0
  let firstError = ''
  try {
    const dims = page.findAllWithCriteria({ types: ['FRAME', 'COMPONENT', 'GROUP'] })
      .filter(node => isDimFrame(node) && !isSelectionBadgeNode(node))
    if (dims.length === 0) { figma.notify('No dimensions on this page.'); return }
    for (const dim of dims) {
      if (figma.currentPage !== page || page.removed || pluginClosed) { skipped += dims.length - updated - skipped - failed; break }
      if (dim.type === 'GROUP' || !canRestyleDimension(dim, page)) { skipped += 1; continue }
      try {
        const meta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
        if (!['h', 'v', 'a', 'r'].includes(meta.axis) || !Number.isFinite(meta.scale) || meta.scale <= 0 || typeof meta.units !== 'string') {
          throw new Error('Invalid dimension metadata')
        }
        const texts = dim.findAllWithCriteria({ types: ['TEXT'] })
        for (const text of texts) {
          const fonts = typeof text.fontName === 'object' ? [text.fontName] : text.getRangeAllFontNames(0, text.characters.length)
          for (const font of fonts) await ensureFont(font)
        }
        await ensureFont({ family: params.fontFamily, style: 'Regular' })
        if (figma.currentPage !== page || pluginClosed || !canRestyleDimension(dim, page)) { skipped += 1; continue }
        reconcileAnnotations()
        const state = JSON.parse(dim.getPluginData(ANNOTATION_STATE_KEY) || '{}') as AnnotationState
        if (state.pending) writeAnnotationLabel(dim)
        const currentMeta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
        if (currentMeta.axis === 'a') {
          if (!await upgradeLegacyDimension(dim, page, true)) { skipped += 1; continue }
        }
        const upgradedMeta = JSON.parse(dim.getPluginData(DIM_DATA_KEY)) as DimMeta
        restyleDimension(dim, upgradedMeta, upgradedMeta.perimeterEdge != null ? { ...params, offset: params.offset + (upgradedMeta.clearanceExtra ?? 0) } : params)
        rememberAnnotations([dim])
        updated += 1
      } catch (error) {
        failed += 1
        if (!firstError) firstError = error instanceof Error ? error.message : String(error)
      }
    }
    figma.notify('Appearance updated: ' + updated + '; skipped: ' + skipped + '; failed or partial: ' + failed
      + (firstError ? '. ' + firstError : '') + (skipped ? '. Locked/instance boundaries, unsupported groups, or page changes are skipped.' : ''),
    { error: failed > 0 })
  } catch (error) {
    figma.notify('Appearance update stopped after ' + updated + ' updates; skipped: ' + skipped + '; failed or partial: ' + failed
      + '. ' + (error instanceof Error ? error.message : String(error)), { error: true })
  } finally {
    isExecuting = false
    if (figma.currentPage === page) reconcileAnnotations()
    try { refreshSelection() } catch { /* A removed/unavailable page must not reject the UI action. */ }
  }
}

async function action_add_dimensions(params: Params, _previousState: unknown | null): Promise<{ affectedNodes: SceneNode[]; state: unknown | null }> {
  const affectedNodes: SceneNode[] = []
  const layerDimNodes: SceneNode[] = []  // track layer dims for dedup
  const page = figma.currentPage
  const selection = figma.currentPage.selection
  await ensureFont({ family: params.fontFamily, style: 'Regular' })
  if (pluginClosed || figma.currentPage !== page) return { affectedNodes, state: null }
  reconcileAnnotations()
  // Resolve all targets and deduplicate — avoids processing the same layer twice
  // when user selects both a layer and its dimension frame
  const processedTargetIds = new Set<string>()
  const resolvedTargets: ResolvedTarget[] = []
  for (const sel of selection) {
    if (sel.removed) continue
    const actualTarget = resolveTarget(sel)
    if (actualTarget == null || actualTarget.removed) continue
    if (processedTargetIds.has(actualTarget.id)) continue
    processedTargetIds.add(actualTarget.id)

    resolvedTargets.push({ node: actualTarget, rect: nodeRect(actualTarget) })
  }

  const sharedVertical = sharedVerticalDimension(resolvedTargets, params)
  const sharedHorizontal = sharedHorizontalDimensions(resolvedTargets, params)
  const selectionBounds = boundsOfTargets(resolvedTargets)
  if (sharedHorizontal.size > 0) {
    const horizontalSlots = new Set(['h:top', 'h:bottom'])
    for (const { node } of resolvedTargets) {
      if (sharedHorizontal.has(node.id)) removeDimensionsAtSlots(node, horizontalSlots)
    }
  }
  if (sharedVertical != null) {
    const verticalSlots = new Set(['v:left', 'v:right'])
    for (const { node } of resolvedTargets) removeDimensionsAtSlots(node, verticalSlots)
  }

  for (const { node: actualTarget, rect } of resolvedTargets) {
    if (actualTarget.type === 'ELLIPSE' && circularRadius(actualTarget) != null) {
      // A circle has one measurement; every placement action moves that leader.
      const previousDimensions = findSiblingDims(actualTarget)
      const radiusDim = await createRadiusDimension(actualTarget, params)
      if (radiusDim != null) {
        for (const previous of previousDimensions) {
          if (!previous.removed) previous.remove()
        }
        affectedNodes.push(actualTarget, radiusDim)
        layerDimNodes.push(radiusDim)
      }
      continue
    }
    removeDimensionsAtSlots(actualTarget, new Set(['r:radius']))
    const perimeterEdges = params.placement === 'auto' ? perimeterEdgesForNode(actualTarget) : null
    if (perimeterEdges != null && perimeterEdges.length > 0) {
      // Snapshot before creation. Moved/freeform and unrelated annotations are not owned.
      const previousDimensions = findSiblingDims(actualTarget)
      const dimensions = await createPerimeterDimensions(actualTarget, perimeterEdges, params)
      for (const previous of previousDimensions) if (!previous.removed) previous.remove()
      affectedNodes.push(actualTarget, ...dimensions)
      layerDimNodes.push(...dimensions)
      continue
    }
    if (params.placement === 'auto') {
      const obsolete = findSiblingDims(actualTarget).map(dim => dimensionSlot(dim, actualTarget) ?? '')
        .filter(slot => slot.startsWith('a:'))
      removeDimensionsAtSlots(actualTarget, new Set(obsolete))
    }
    const individualSides = placementToSides(params.placement, actualTarget, params)
    const autoSides = params.placement === 'auto' && selectionBounds != null && resolvedTargets.length > 1
      ? outwardPlacement(rect, selectionBounds, individualSides)
      : individualSides
    const ownsSharedVertical = sharedVertical == null || sharedVertical.targetId === actualTarget.id
    const heightSides = sharedVertical != null && ownsSharedVertical
      ? { ...autoSides, heightSide: sharedVertical.side }
      : autoSides
    const widthOwner = sharedHorizontal.get(actualTarget.id)
    const sides = widthOwner === actualTarget.id ? { ...heightSides, widthSide: 'bottom' as const } : heightSides
    const targetParams = { ...params,
      showWidth: params.showWidth && (widthOwner == null || widthOwner === actualTarget.id),
      showHeight: params.showHeight && ownsSharedVertical }
    const requestedSlots = replacementSlots(params.placement, targetParams.showWidth, targetParams.showHeight, sides)
    removeDimensionsAtSlots(actualTarget, requestedSlots)
    const dimNodes = await buildDimensions(actualTarget, targetParams, sides)
    affectedNodes.push(actualTarget)
    for (const node of dimNodes) {
      affectedNodes.push(node)
      layerDimNodes.push(node)
    }
  }

  // Remove duplicate extension lines where adjacent layer dims share an edge
  if (layerDimNodes.length >= 2) {
    deduplicateLayerDimExtensions(layerDimNodes)
  }

  // When multiple objects are selected, annotate the gaps between them
  if (resolvedTargets.length >= 2) {
    affectedNodes.push(...await replaceGapDimensions(resolvedTargets, params))
  }

  rememberAnnotations(affectedNodes)
  return { affectedNodes, state: null }
}
async function runAction_add_dimensions(params: Params, notify: boolean): Promise<void> {
  if (pluginClosed || isExecuting) return  // guard against re-entrant calls from rapid clicks
  isExecuting = true
  try {
    const result = await action_add_dimensions(params, null)
    // Remove any legacy per-shape settings; preferences are document-wide only.
    for (const node of result.affectedNodes) {
      if (!node.removed && !isDimFrame(node)) {
        node.setPluginData(ATTACH_KEY, '')
      }
    }
    attachRelaunch(result.affectedNodes)
    pushActionStates()
    if (notify) {
      figma.notify(DISPLAY_NAME + " applied")
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    figma.notify(message, { error: true })
    throw error
  } finally {
    isExecuting = false
    reconcileAnnotations()
    refreshSelection()
  }
}


async function runAction_create_blank(params: Params): Promise<void> {
  if (pluginClosed || isExecuting) return
  isExecuting = true
  try {
    const page = figma.currentPage
    await ensureFont({ family: params.fontFamily, style: 'Regular' })
    if (pluginClosed || figma.currentPage !== page) return
    const fontPaint = solidPaint(params.fontColor)
    const linePaint = solidPaint(params.lineColor)
    const defaultSize = 200
    const affectedNodes: SceneNode[] = []
    const center = figma.viewport.center
    const placement = params.placement

    // auto → both, up/down → horizontal, left/right → vertical
    const createH = placement === 'auto' || placement === 'up' || placement === 'down'
    const createV = placement === 'auto' || placement === 'left' || placement === 'right'
    const hSide: 'top' | 'bottom' = placement === 'up' ? 'top' : 'bottom'
    const vSide: 'left' | 'right' = placement === 'left' ? 'left' : 'right'

    if (createH) {
      const meta: DimMeta = { axis: 'h', side: hSide, scale: params.scale, units: params.units, decimals: params.decimals }
      const dim = await createHDimFrame(defaultSize, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, hSide, params.endpointStyle)
      dim.x = Math.round(center.x - defaultSize / 2)
      dim.y = Math.round(center.y - dim.height / 2)
      affectedNodes.push(dim)
    }

    if (createV) {
      const meta: DimMeta = { axis: 'v', side: vSide, scale: params.scale, units: params.units, decimals: params.decimals }
      const dim = await createVDimFrame(defaultSize, meta, fontPaint, linePaint, params.fontSize, params.fontFamily, params.offset, params.labelOffset, params.strokeWeight, vSide, params.endpointStyle)
      const offsetX = createH ? defaultSize / 2 + 20 : 0
      dim.x = Math.round(center.x + offsetX)
      dim.y = Math.round(center.y - defaultSize / 2)
      affectedNodes.push(dim)
    }

    rememberAnnotations(affectedNodes)
    attachRelaunch(affectedNodes)
    figma.currentPage.selection = affectedNodes
    pushActionStates()
    figma.notify("Blank dimension created")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    figma.notify(message, { error: true })
    throw error
  } finally {
    isExecuting = false
    reconcileAnnotations()
    refreshSelection()
  }
}

function pushActionStates(): void {
  const selection = figma.currentPage.selection
  const enabled_add_dimensions = evaluateEnabled_add_dimensions(selection)
  figma.ui.postMessage({
    type: 'action-state',
    actions: {
      "add-dimensions": { enabled: enabled_add_dimensions, status: status_add_dimensions(selection) },
    },
  })
}
function refreshSelection(): void {
  if (pluginClosed) return
  // Selection changes can be emitted while an action is still running. Never
  // leave the transient badge behind in that case: tear it down immediately,
  // then let the action's finally block rebuild it from the settled selection.
  if (isExecuting) {
    removeSelectionBadge()
    removeStaleSelectionBadges()
    return
  }
  latestParams = loadDocParams()
  figma.ui.postMessage({ type: 'params-change', params: latestParams })
  reconcileSelectionBadge(true)
  if (selectionBadgeTarget != null) updateSelectionBadge(selectionBadgeTarget)
  pushActionStates()
}

const initialParams: Params = loadDocParams()
latestParams = initialParams
let html = __html__
html = html.replace(/(id="units"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.units)) + '$2')
html = html.replace(/(id="scale"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.scale)) + '$2')
html = html.replace(/(id="decimals"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.decimals)) + '$2')
html = html.replace(/(id="offset"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.offset)) + '$2')
html = html.replace(/(id="labelOffset"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.labelOffset)) + '$2')
html = html.replace(/(id="strokeWeight"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.strokeWeight)) + '$2')
html = html.replace(/(id="fontSize"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.fontSize)) + '$2')
html = html.replace(/(id="fontFamily"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(String(initialParams.fontFamily)) + '$2')
html = html.replace(/(id="fontColor"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(colorToHex(initialParams.fontColor)) + '$2')
html = html.replace(/(id="lineColor"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(colorToHex(initialParams.lineColor)) + '$2')
const endpointDisplayMap: Record<string, string> = { slash: 'Slash', 'line-arrow': 'Arrow', arrow: 'Triangle' }
html = html.replace(/(id="endpointStyle"[^>]*\bvalue=")[^"]*(")/g, '$1' + htmlEscapeAttribute(endpointDisplayMap[initialParams.endpointStyle] ?? 'Slash') + '$2')
figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
figma.showUI(html, { width: 320, height: 320 })
removeStaleSelectionBadges()
void syncSelectionBadge()
pushActionStates()
figma.on('selectionchange', refreshSelection)
figma.on('currentpagechange', onCurrentPageChange)
figma.on('close', cleanupPlugin)
setupAutoRefresh()
setupSelectionBadgeZoomWatch()

// Send available font families to UI
void figma.listAvailableFontsAsync().then((fonts) => {
  const families = [...new Set(fonts.map(f => f.fontName.family))].sort()
  figma.ui.postMessage({ type: 'available-fonts', fonts: families })
}).catch(() => { /* font list unavailable — keep default */ })

figma.ui.onmessage = (msg: RunMsg) => {
  if (pluginClosed) return
  if (msg.type === 'resize') {
    figma.ui.resize(320, Math.max(120, Math.min(900, Math.round(msg.height))))
    return
  }
  if (msg.type === 'reset-defaults') {
    latestParams = { ...DEFAULTS }
    saveDocParams(latestParams)
    figma.ui.postMessage({ type: 'params-change', params: latestParams })
    return
  }
  if (msg.type === 'reset-appearance') {
    latestParams = {
      ...latestParams,
      offset: DEFAULTS.offset,
      labelOffset: DEFAULTS.labelOffset,
      strokeWeight: DEFAULTS.strokeWeight,
      fontSize: DEFAULTS.fontSize,
      fontFamily: DEFAULTS.fontFamily,
      fontColor: DEFAULTS.fontColor,
      lineColor: DEFAULTS.lineColor,
      endpointStyle: DEFAULTS.endpointStyle,
    }
    saveDocParams(latestParams)
    figma.ui.postMessage({ type: 'params-change', params: latestParams })
    return
  }
  if (msg.type === 'params-update') {
    latestParams = normalizeParams(msg.params)
    saveDocParams(latestParams)
    if (selectionBadgeTarget != null) updateSelectionBadge(selectionBadgeTarget)
    return
  }
  if (msg.type === 'action') {
    if (msg.id === 'update-appearance') {
      if (isExecuting) { figma.notify('Another action is in progress. Try again when it finishes.'); return }
      const actionParams = normalizeParams(msg.params)
      latestParams = withAppearance(latestParams, actionParams)
      saveDocParams(latestParams)
      void runAction_update_appearance(actionParams)
      return
    }
    if (msg.id === "add-dimensions") {
      if (isExecuting) return
      const actionParams = normalizeParams(msg.params)
      latestParams = { ...actionParams, placement: 'auto', showWidth: true, showHeight: true }
      saveDocParams(latestParams)
      const selection = figma.currentPage.selection
      if (selection.length === 0) {
        void runAction_create_blank(actionParams)
      } else {
        void runAction_add_dimensions(actionParams, true)
      }
      return
    }
    return
  }
}
