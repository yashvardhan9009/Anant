import * as C from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './earth.css';
import { publicTerrain } from './terrain';
import { DESTINATIONS, parseCoordinates, type Place } from './places';
import { EarthNavigator, type TravelMode } from './EarthNavigator';
import { EarthSound } from './EarthSound';
import { cinematicAtmosphere } from './atmosphere';

const el = <T extends keyof HTMLElementTagNameMap>(tag: T, className = '', text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};
export interface EarthView {position:[number,number,number];heading:number;pitch:number;roll:number;target?:Place;lighting:string}

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
  navigator?: EarthNavigator;
  private sound = new EarthSound();
  private atmosphere?: ReturnType<typeof cinematicAtmosphere>;
  private light = el('select');
  private hints = el('div', 'earth-hints', 'Drag to explore · Scroll to approach · Ctrl + drag to tilt');
  private readout = el('div', 'earth-readout');
  private modes = new Map<TravelMode, HTMLButtonElement>();
  private panel = el('aside', 'earth-panel');
  private journey = el('button', 'earth-journey', 'Start scenic flight');
  private cruiseButton = el('button', '', 'Cruise');
  private fullscreen = el('button', '', 'Full screen');
  private removeLoading?: () => void;
  private flightGeneration = 0;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private fullscreenChanged = () => this.fullscreen.textContent = document.fullscreenElement === this.root ? 'Exit full screen' : 'Full screen';
  private exit = () => this.onClose();
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.navigator?.mode !== 'explore' && this.navigator) this.setMode('explore');
      else if (this.root.classList.contains('earth-cinema')) this.toggleCinema();
      else this.onClose();
    }
    if (e.key === 'Tab') {
      const items = [...this.root.querySelectorAll<HTMLElement>('button,input,summary,select,canvas')].filter(n => n.offsetParent !== null && getComputedStyle(n).visibility !== 'hidden' && !n.hasAttribute('disabled'));
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };

  constructor(private onClose: () => void, onImagine?: (place:string)=>void) {
    this.root.setAttribute('aria-label', 'Earth explorer');
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true');
    const chrome = el('header', 'earth-header');
    const back = el('button', 'earth-back', '← Return to ANANT'); back.onclick = this.exit;
    const title = el('div', 'earth-title'); title.append(el('span', '', 'ANANT / EARTH'), this.location);
    const actions = el('div', 'earth-actions');
    const orbit = el('button', '', 'Orbit'); orbit.setAttribute('aria-pressed', 'false');
    orbit.classList.add('earth-orbit');
    orbit.onclick = () => { const on = !this.orbiting; this.setMode('explore'); this.viewer?.camera.cancelFlight(); this.orbiting = on; orbit.setAttribute('aria-pressed', String(on)); };
    const cinema = el('button', '', 'Cinema');
    cinema.className = 'earth-cinema-button'; cinema.onclick = () => this.toggleCinema();
    const placesToggle = el('button', '', 'Places'); placesToggle.setAttribute('aria-expanded', 'true');
    placesToggle.onclick = () => { this.panel.hidden = !this.panel.hidden; placesToggle.setAttribute('aria-expanded', String(!this.panel.hidden)); };
    this.fullscreen.onclick = async () => {
      try { if (document.fullscreenElement === this.root) await document.exitFullscreen(); else await this.root.requestFullscreen(); }
      catch { this.status.textContent = 'Full screen is unavailable in this browser. Cinema still hides the controls.'; }
    };
    document.addEventListener('fullscreenchange', this.fullscreenChanged);
    const imagine=el('button','','Imagine / past');imagine.title='Create a scene using the last selected destination as a starting point';imagine.onclick=()=>onImagine?.(this.target?.name??'');
    actions.append(placesToggle, orbit, cinema, this.fullscreen); chrome.append(back, title, actions);
    const panel = this.panel;
    const form = el('form', 'earth-search');
    this.input.placeholder = 'City or latitude, longitude'; this.input.setAttribute('aria-label', 'Search cities or coordinates');
    const submit = el('button', '', 'Fly'); submit.type = 'submit';
    form.append(this.input, submit); form.onsubmit = e => { e.preventDefault(); void this.search(); };
    const places = el('div', 'earth-places');
    for (const place of DESTINATIONS) { const b = el('button', '', place.name); b.onclick = () => this.flyTo(place); places.append(b); }
    const note = el('details', 'earth-data');
    note.append(el('summary', '', 'Imagery & terrain'));
    this.info.textContent = 'Public satellite imagery draped over measured terrain. Global Sentinel imagery: 2016, approximately 10 m. US aerial imagery: approximately 1 m where available. Dates and detail vary. Buildings are photographed from above; this mode has no reconstructed 3D buildings. Lighting presets simulate a midsummer day; wind is synthesized ambience. Ground-level detail is limited by the imagery.';
    note.append(this.info); panel.append(form, this.results, places, imagine, note);
    const experience = el('div', 'earth-experience');
    const sunlight = el('label', 'earth-setting', 'Lighting');
    this.light.setAttribute('aria-label', 'Lighting');
    for (const [value, name] of [['day','Daylight'], ['golden','Golden hour'], ['blue','Blue hour']]) {
      const option = el('option', '', name); option.value = value; this.light.append(option);
    }
    this.light.onchange = () => this.setLighting(); sunlight.append(this.light);
    const wind = el('button', '', 'Wind off'); wind.setAttribute('aria-pressed', 'false');
    wind.onclick = async () => { const enabled = await this.sound.toggle(); wind.textContent = enabled ? 'Wind on' : 'Wind off'; wind.setAttribute('aria-pressed', String(enabled)); };
    experience.append(sunlight, wind); panel.append(experience);
    const dock = el('nav', 'earth-dock'); dock.setAttribute('aria-label', 'Earth travel controls');
    for (const [mode, name] of [['explore','Explore'], ['fly','Fly freely'], ['walk','Walk terrain']] as [TravelMode,string][]) {
      const button = el('button', '', name); button.setAttribute('aria-pressed', String(mode === 'explore'));
      button.onclick = () => this.setMode(mode); this.modes.set(mode, button); dock.append(button);
    }
    this.cruiseButton.setAttribute('aria-pressed', 'false'); this.cruiseButton.hidden = true;
    this.cruiseButton.onclick = () => { if (this.navigator) { this.navigator.cruise = !this.navigator.cruise; this.cruiseButton.setAttribute('aria-pressed', String(this.navigator.cruise)); this.viewer?.canvas.focus(); } };
    dock.append(this.cruiseButton);
    this.journey.onclick = () => this.startJourney();
    const controls = el('div', 'earth-travel'); controls.append(this.journey, dock, this.hints);
    const touch = el('div', 'earth-movement'); touch.setAttribute('aria-label', 'Movement');
    for (const [key, name, symbol] of [['w','Move forward','↑'],['a','Move left','←'],['s','Move backward','↓'],['d','Move right','→'],['e','Rise','+'],['q','Descend','−']]) {
      const button = el('button', '', symbol); button.setAttribute('aria-label', name);
      button.onpointerdown = event => { event.preventDefault(); button.setPointerCapture(event.pointerId); this.navigator?.keys.add(key); };
      const release = () => this.navigator?.keys.delete(key);
      button.onpointerup = release; button.onpointercancel = release; button.onlostpointercapture = release;
      button.onkeydown = event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.navigator?.keys.add(key); } };
      button.onkeyup = release; button.onblur = release; touch.append(button);
    }
    const footer = el('footer', 'earth-footer');
    footer.append(this.status, this.readout);
    this.status.setAttribute('role', 'status');
    this.root.append(this.canvasHost, chrome, panel, controls, touch, footer);
    document.body.append(this.root);
    window.addEventListener('keydown', this.key, true);
    this.root.addEventListener('pointerdown', () => { this.lastTime = performance.now(); });
    back.focus();
  }

  async start(resumeView?: EarthView) {
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
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.dynamicAtmosphereLighting = true;
    viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;
    viewer.scene.globe.atmosphereLightIntensity = 7;
    viewer.scene.globe.atmosphereSaturationShift = -.18;
    viewer.scene.skyAtmosphere!.show = true;
    viewer.scene.skyAtmosphere!.saturationShift = -.2;
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
    viewer.scene.fog.enabled = true;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 35;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 40000000;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    viewer.scene.highDynamicRange = true;
    this.atmosphere = cinematicAtmosphere(viewer);
    this.navigator = new EarthNavigator(viewer, () => { this.orbiting = false; });
    this.removeLoading = viewer.scene.globe.tileLoadProgressEvent.addEventListener((count: number) => {
      this.root.classList.toggle('earth-loading', count > 0);
      this.root.setAttribute('aria-busy', String(count > 0));
    });
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
    satellite.brightness = .95; satellite.saturation = .94;
    imagery.errorEvent.addEventListener(() => { this.status.textContent = 'Imagery service unavailable. Terrain may still load.'; });
    if (resumeView) this.restoreView(resumeView);
    else { this.flyTo(DESTINATIONS[0], 0); this.setMode('fly'); }
    // Public-domain US aerial imagery only refines the continental US rectangle.
    const aerial = new C.UrlTemplateImageryProvider({
      url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox={westProjected},{southProjected},{eastProjected},{northProjected}&bboxSR=3857&imageSR=3857&size=256,256&format=png&f=image',
      maximumLevel: 18,
      rectangle: C.Rectangle.fromDegrees(-125, 24, -66, 50),
      credit: new C.Credit('US aerial imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program">USGS / USDA NAIP</a>', true),
    });
    viewer.imageryLayers.add(new C.ImageryLayer(aerial, { minimumTerrainLevel: 7 }));
    this.removeTick = viewer.clock.onTick.addEventListener(() => {
      const now = performance.now(), dt = Math.min((now - this.lastTime) / 1000, .1); this.lastTime = now;
      this.navigator?.update(dt);
      this.sound.update(this.navigator?.speed ?? 0, viewer.camera.positionCartographic.height, viewer.camera.heading);
      if (this.orbiting && this.target) {
        const center = C.Cartesian3.fromDegrees(this.target.lon, this.target.lat, this.target.elevation ?? 0);
        viewer.camera.lookAt(center, new C.HeadingPitchRange(viewer.camera.heading + dt * .035, viewer.camera.pitch, C.Cartesian3.distance(viewer.camera.positionWC, center)));
        viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
        viewer.scene.requestRender();
      }
      if (now - this.lastAltitude > 250) {
        const height = viewer.camera.positionCartographic.height;
        this.status.textContent = viewer.scene.globe.tilesLoaded ? 'Satellite imagery · measured terrain' : 'Refining terrain & imagery…';
        const speed = this.navigator?.speed ?? 0, heading = Math.round(C.Math.toDegrees(viewer.camera.heading)) % 360;
        this.readout.textContent = `${heading.toString().padStart(3,'0')}° · ${(height / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km altitude${this.navigator?.mode !== 'explore' ? ` · ${Math.round(speed * 3.6)} km/h` : ''}`;
        this.cruiseButton.setAttribute('aria-pressed', String(this.navigator?.cruise ?? false));
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
    this.flightGeneration++; this.setMode('explore'); this.target = place; this.location.textContent = place.name;
    this.setLighting();
    this.results.replaceChildren();
    const center = C.Cartesian3.fromDegrees(place.lon, place.lat, place.elevation ?? 0);
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(center, 1), {
      duration: this.reducedMotion ? 0 : duration, offset: new C.HeadingPitchRange(place.heading ?? 0, C.Math.toRadians(place.pitch ?? -55), place.range),
      complete:()=>{if(!this.disposed)this.setMode('fly');},
    });
  }

  snapshot():EarthView|undefined {
    const c=this.viewer?.camera;if(!c)return;
    return {position:[c.positionWC.x,c.positionWC.y,c.positionWC.z],heading:c.heading,pitch:c.pitch,roll:c.roll,target:this.target,lighting:this.light.value};
  }
  restoreView(view:EarthView){
    if(!this.viewer)return;
    this.target=view.target;this.location.textContent=view.target?.name??'Earth';this.light.value=view.lighting;this.setLighting();
    this.viewer.camera.cancelFlight();this.viewer.camera.setView({destination:new C.Cartesian3(...view.position),orientation:{heading:view.heading,pitch:view.pitch,roll:view.roll}});
    this.setMode('fly');
  }

  private toggleCinema() {
    const hidden = this.root.classList.toggle('earth-cinema');
    this.root.querySelector('.earth-cinema-button')!.textContent = hidden ? 'Show controls' : 'Cinema';
  }

  setMode(mode: TravelMode) {
    this.flightGeneration++; this.orbiting = false;
    this.root.querySelector('.earth-orbit')?.setAttribute('aria-pressed', 'false');
    if (!this.navigator) return;
    const accepted = this.navigator.setMode(mode);
    if (!accepted) mode = 'explore';
    this.root.dataset.travel = mode;
    for (const [id, button] of this.modes) button.setAttribute('aria-pressed', String(id === mode));
    this.cruiseButton.hidden = mode !== 'fly'; this.journey.hidden = mode !== 'explore';
    this.hints.textContent = mode === 'explore' ? 'Drag to explore · Scroll to approach · Ctrl + drag to tilt'
      : mode === 'fly' ? 'WASD to fly · Drag to look · E / Q rise & descend · Shift faster · Esc stops'
      : 'WASD to walk · Drag to look · Shift to run · Esc stops';
    if (!accepted) this.hints.textContent = 'Approach the surface and let the terrain load before walking.';
  }

  private setLighting() {
    if (!this.viewer) return;
    const lon = this.target?.lon ?? 78;
    const hour = this.light.value === 'golden' ? 18 : this.light.value === 'blue' ? 20 : 13;
    // A simulated midsummer day, expressed as local solar time, not live weather.
    const date = new Date(Date.UTC(new Date().getUTCFullYear(), 5, 21));
    date.setTime(date.getTime() + (hour - lon / 15) * 3600000);
    this.viewer.clock.currentTime = C.JulianDate.fromDate(date); this.viewer.clock.shouldAnimate = false;
    this.atmosphere?.set(this.light.value === 'golden' ? 1 : 0, this.light.value === 'blue' ? 1.4 : 1);
    this.viewer.scene.skyAtmosphere!.brightnessShift = this.light.value === 'blue' ? -.12 : -.03;
  }

  private startJourney() {
    if (!this.viewer) return;
    const place = this.target && this.target.name !== 'Earth' ? this.target : DESTINATIONS[2];
    this.flyTo(place);
    const generation = this.flightGeneration;
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(place.lon, place.lat, place.elevation ?? 0), 1), {
      duration: this.reducedMotion ? 0 : 6,
      offset: new C.HeadingPitchRange(place.heading ?? 0, C.Math.toRadians(place.pitch ?? -25), place.range),
      complete: () => {
        if (this.disposed || generation !== this.flightGeneration) return;
        this.setMode('fly'); this.navigator!.cruise = !this.reducedMotion;
        this.hints.textContent = this.reducedMotion ? 'Flight ready · WASD to move · Drag to look · Esc stops' : 'Cruising · Drag to look · WASD to steer · Esc stops';
      },
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
    this.disposed = true; this.flightGeneration++; this.navigator?.dispose(); this.sound.dispose();
    this.terrain?.dispose(); this.removeTick?.(); this.removeLoading?.();
    document.removeEventListener('fullscreenchange', this.fullscreenChanged);
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    window.removeEventListener('keydown', this.key, true); this.root.remove();
  }
}
