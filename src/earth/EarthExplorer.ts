import * as C from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './earth.css';
import { publicTerrain } from './terrain';
import { DESTINATIONS, parseCoordinates, type Place } from './places';

const el = <T extends keyof HTMLElementTagNameMap>(tag: T, className = '', text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};

/** Separate geospatial camera: metre-scale surface detail must not use the solar
 * system's deliberately compressed scene coordinates. No world state is changed. */
export class EarthExplorer {
  readonly root = el('section', 'earth-explorer');
  viewer?: C.Viewer;
  private canvasHost = el('div', 'earth-canvas');
  private status = el('div', 'earth-status', 'Connecting to Earth…');
  private location = el('div', 'earth-location', 'Our home planet');
  private input = el('input');
  private info = el('p');
  private results = el('div', 'earth-results');
  private terrain?: ReturnType<typeof publicTerrain>;
  private disposed = false;
  private google = false;
  private cities?: Promise<[string, string, number, number][]>;
  private orbiting = false;
  private target?: Place;
  private removeTick?: () => void;
  private lastTime = performance.now();
  private lastAltitude = 0;
  private exit = () => this.onClose();
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.onClose(); }
    if (e.key === 'Tab') {
      const items = [...this.root.querySelectorAll<HTMLElement>('button,input,summary')].filter(n => n.offsetParent !== null);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };

  constructor(private onClose: () => void) {
    this.root.setAttribute('aria-label', 'Earth explorer');
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true');
    const chrome = el('header', 'earth-header');
    const back = el('button', 'earth-back', '← Return to ANANT'); back.onclick = this.exit;
    const title = el('div', 'earth-title'); title.append(el('span', '', 'ANANT / EARTH'), this.location);
    const actions = el('div', 'earth-actions');
    const orbit = el('button', '', 'Orbit'); orbit.setAttribute('aria-pressed', 'false');
    orbit.onclick = () => { this.orbiting = !this.orbiting; orbit.setAttribute('aria-pressed', String(this.orbiting)); };
    const cinema = el('button', '', 'Cinema');
    cinema.onclick = () => { const hidden = this.root.classList.toggle('earth-cinema'); cinema.textContent = hidden ? 'Show controls' : 'Cinema'; };
    actions.append(orbit, cinema); chrome.append(back, title, actions);
    const panel = el('aside', 'earth-panel');
    const form = el('form', 'earth-search');
    this.input.placeholder = 'City or latitude, longitude'; this.input.setAttribute('aria-label', 'Search cities or coordinates');
    const submit = el('button', '', 'Fly'); submit.type = 'submit';
    form.append(this.input, submit); form.onsubmit = e => { e.preventDefault(); void this.search(); };
    const places = el('div', 'earth-places');
    for (const place of DESTINATIONS) { const b = el('button', '', place.name); b.onclick = () => this.flyTo(place); places.append(b); }
    const note = el('details', 'earth-data');
    note.append(el('summary', '', 'Imagery & terrain'));
    this.info.textContent = 'Public satellite imagery draped over measured terrain. Global Sentinel imagery: 2016, approximately 10 m. US aerial imagery: approximately 1 m where available. Dates and detail vary. Buildings are photographed from above; this mode has no reconstructed 3D buildings.';
    note.append(this.info); panel.append(form, this.results, places, note);
    const footer = el('footer', 'earth-footer');
    footer.append(el('span', '', 'Drag to explore · Scroll to zoom · Ctrl + drag to tilt'), this.status);
    this.status.setAttribute('role', 'status');
    this.root.append(this.canvasHost, chrome, panel, footer);
    document.body.append(this.root);
    window.addEventListener('keydown', this.key, true);
    this.root.addEventListener('pointerdown', () => { this.lastTime = performance.now(); });
    back.focus();
  }

  async start() {
    (window as any).CESIUM_BASE_URL = '/cesium/';
    C.Ion.defaultAccessToken = '';
    this.terrain = publicTerrain(() => { if (!this.disposed) this.status.textContent = 'Some terrain tiles could not load. Move or zoom to retry.'; });
    const viewer = this.viewer = new C.Viewer(this.canvasHost, {
      baseLayer: false, baseLayerPicker: false, geocoder: false, animation: false,
      timeline: false, navigationHelpButton: false, homeButton: false,
      sceneModePicker: false, fullscreenButton: false, selectionIndicator: false, infoBox: false,
      // Custom DEM fetches are outside Cesium's RequestScheduler; keep frames
      // advancing while their geometry/imagery dependencies progressively load.
      terrainProvider: this.terrain.provider, requestRenderMode: false,
      maximumRenderTimeChange: Infinity, msaaSamples: 4,
    });
    viewer.resolutionScale = Math.min(devicePixelRatio, 1.5);
    viewer.cesiumWidget.creditDisplay.addStaticCredit(new C.Credit('City locations: <a href="https://www.geonames.org">GeoNames</a> · CC BY 4.0', true));
    viewer.scene.postProcessStages.fxaa.enabled = true;
    viewer.scene.globe.baseColor = C.Color.fromCssColorString('#12202b');
    viewer.scene.globe.maximumScreenSpaceError = 2;
    viewer.scene.globe.tileCacheSize = 180;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.globe.enableLighting = false; // Imagery already contains photographed lighting.
    viewer.scene.skyAtmosphere!.show = true;
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
    viewer.scene.fog.enabled = true;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 35;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 40000000;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    viewer.scene.highDynamicRange = true;
    // Freely licensed global imagery; no ArcGIS account or undisclosed token.
    const imagery = new C.UrlTemplateImageryProvider({
      url: '/api/earth/imagery/{z}/{x}/{y}.jpg',
      maximumLevel: 14,
      credit: new C.Credit('<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by <a href="https://eox.at">EOX</a> · Copernicus 2016 · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>', true),
    });
    // A packaged orbital map makes initial Earth visible even on a slow network.
    const fallback = await C.SingleTileImageryProvider.fromUrl('/assets/space/8k_earth_daymap.jpg', {
      credit: new C.Credit('Orbital map: <a href="https://www.solarsystemscope.com/textures/">Solar System Scope / NASA</a> · CC BY 4.0', true),
    });
    if (this.disposed) return;
    viewer.imageryLayers.addImageryProvider(fallback);
    const satellite = viewer.imageryLayers.addImageryProvider(imagery);
    satellite.brightness = .88; satellite.saturation = .9;
    imagery.errorEvent.addEventListener(() => { this.status.textContent = 'Imagery service unavailable. Terrain may still load.'; });
    this.flyTo(DESTINATIONS[0], 0);
    // Public-domain US aerial imagery only refines the continental US rectangle.
    const aerial = new C.UrlTemplateImageryProvider({
      url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox={westProjected},{southProjected},{eastProjected},{northProjected}&bboxSR=3857&imageSR=3857&size=256,256&format=png&f=image',
      maximumLevel: 18,
      rectangle: C.Rectangle.fromDegrees(-125, 24, -66, 50),
      credit: new C.Credit('US aerial imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program">USGS / USDA NAIP</a>', true),
    });
    viewer.imageryLayers.addImageryProvider(aerial);
    this.removeTick = viewer.clock.onTick.addEventListener(() => {
      const now = performance.now(), dt = Math.min((now - this.lastTime) / 1000, .05); this.lastTime = now;
      viewer.scene.globe.enableLighting = viewer.camera.positionCartographic.height > 1000000;
      if (this.orbiting && this.target) {
        const center = C.Cartesian3.fromDegrees(this.target.lon, this.target.lat, this.target.elevation ?? 0);
        viewer.camera.lookAt(center, new C.HeadingPitchRange(viewer.camera.heading + dt * .035, viewer.camera.pitch, C.Cartesian3.distance(viewer.camera.positionWC, center)));
        viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
        viewer.scene.requestRender();
      }
      if (now - this.lastAltitude > 1000 && viewer.scene.globe.tilesLoaded) {
        const height = viewer.camera.positionCartographic.height;
        this.status.textContent = `${this.google ? 'Google photorealistic 3D' : 'Public satellite + terrain'} · ${(height / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km altitude`;
        this.lastAltitude = now;
      }
    });
    try {
      const config = await fetch('/api/earth/config').then(r => r.json());
      if (this.disposed || !config.googleMapsKey) return;
      const tiles = await C.createGooglePhotorealistic3DTileset({ key: config.googleMapsKey, onlyUsingWithGoogleGeocoder: true }, { maximumScreenSpaceError: 8 });
      if (this.disposed) { tiles.destroy(); return; }
      viewer.scene.primitives.add(tiles); viewer.scene.globe.show = false; this.google = true;
      // No non-Google geocoding is mixed with Google's tiles. Bookmarks and direct
      // coordinates remain available without a separate Google geocoding API.
      this.input.placeholder = 'Latitude, longitude';
      this.input.setAttribute('aria-label', 'Go to coordinates');
      this.info.textContent = 'Google Photorealistic 3D Tiles. Coverage varies. Use the destinations or enter coordinates. Provider credits remain visible in cinema mode.';
      viewer.scene.requestRender();
    } catch { if (!this.disposed) this.status.textContent = 'Using public satellite imagery and terrain.'; }
  }

  flyTo(place: Place, duration = 3.5) {
    if (!this.viewer || this.disposed) return;
    this.orbiting = false; this.target = place; this.location.textContent = place.name;
    this.root.querySelector('[aria-pressed]')?.setAttribute('aria-pressed', 'false');
    this.results.replaceChildren();
    const center = C.Cartesian3.fromDegrees(place.lon, place.lat, place.elevation ?? 0);
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(center, 1), {
      duration, offset: new C.HeadingPitchRange(0, C.Math.toRadians(place.pitch ?? -55), place.range),
    });
  }

  private async search() {
    const query = this.input.value.trim(); if (!query) return;
    const coordinates = parseCoordinates(query); if (coordinates) { this.flyTo(coordinates); return; }
    if (this.google) { this.results.textContent = 'Enter latitude, longitude, or choose a destination.'; return; }
    this.results.textContent = 'Finding cities…';
    try {
      this.cities ??= fetch('/assets/earth/cities.json').then(r => { if (!r.ok) throw new Error('Cities unavailable'); return r.json(); });
      const cities = await this.cities;
      if (this.disposed || this.input.value.trim() !== query) return;
      const normalized = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const q = normalized(query);
      const matches = cities.filter(c => normalized(`${c[0]} ${c[1]}`).includes(q)).slice(0, 8);
      this.results.replaceChildren();
      if (!matches.length) this.results.textContent = 'No matching city. Try latitude, longitude.';
      for (const [name, country, lat, lon] of matches) {
        const b = el('button', '', `${name}, ${country}`);
        b.onclick = () => this.flyTo({ name: `${name}, ${country}`, lon, lat, range: 12000, pitch: -60 }); this.results.append(b);
      }
    } catch { this.cities = undefined; this.results.textContent = 'City search unavailable. Destinations and coordinates still work.'; }
  }

  dispose() {
    this.disposed = true; this.terrain?.dispose(); this.removeTick?.();
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    window.removeEventListener('keydown', this.key, true); this.root.remove();
  }
}
