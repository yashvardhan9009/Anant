/**
 * The Heavy-Gravity Universe — ANANT's first hypothetical universe.
 *
 * Same N-body engine, same solar-system masses and orbit sizes, but G is multiplied by
 * the universe's constant. Velocities are rescaled by √G so the planets stay on circular
 * orbits; everything else (faster years, energy, orbital elements) is computed live.
 * The premise is not observed physics, and every card says so.
 */
import { Cosmos } from './Cosmos';
import type { InfoCard } from '../engine/Realm';
import type { WorldState } from '../../shared/worldState';
import { UNIVERSES, derived, universeSystem, formatYears } from '../../shared/universes';

const U = UNIVERSES.heavy;

export class HeavyUniverse extends Cosmos {
  readonly id = 'heavy' as const;
  protected cosmic = false;
  protected starImagery = false;
  private bodies = universeSystem(U).map((b) => (b.id === 'sun' ? { ...b, name: 'Sun′', color: U.starTint } : b));

  protected build() {
    super.build();
    this.look = { ...this.look, saturation: 0.95, shadows: '#0a0618', highlights: '#e8f0ff' };
  }

  /** Present this universe's own system to the shared Cosmos machinery. */
  sync(state: WorldState, t: number) {
    const env = state.env.heavy;
    super.sync(
      {
        ...state,
        cosmos: { preset: 'solar_system', epoch: 0, bodies: this.bodies, timeScale: state.cosmos.timeScale, paused: state.cosmos.paused, trails: true, blackHole: false },
        env: { ...state.env, cosmos: { ...env, gravity: U.G * env.gravity } },
      },
      t,
    );
  }

  info(s: WorldState): InfoCard {
    const base = super.info(s);
    const d = derived(U);
    const g = U.G * s.env.heavy.gravity;
    const earth = this.sim.index('earth');
    const orbit = earth >= 0 && g > 0 ? this.sim.orbitalElements(earth, this.sim.index('sun')) : undefined;
    const year = orbit && orbit.e < 1 && Number.isFinite(orbit.period) ? `${(orbit.period * 365.25).toFixed(0)} days` : 'unbound';
    return {
      title: U.name,
      mode: 'HYPOTHETICAL UNIVERSE',
      subtitle: s.env.heavy.gravity === 1 ? `${U.premise} Initially, Earth′ takes ${d.earthYearDays.toFixed(0)} days to orbit.` : `You changed gravity to ${g}× ours. Existing velocities are retained; the live orbit responds to the new force.`,
      accuracy: [
        { tag: 'HYPOTHETICAL', text: `Not our universe. G here is ${g}× the measured value — a "what if", not an observation.` },
        { tag: 'SIMULATION', text: 'The same Newtonian N-body integrator as our Cosmos, run with the stronger G. Orbits, periods and energy are computed live.' },
        { tag: 'MODEL', text: `At baseline G×4, stellar homology (L ∝ G⁴M³) predicts about ${d.luminosity}× the brightness and ~${formatYears(d.sunLifetimeYr)} lifetime instead of ~10 billion. This estimate is not recomputed when you edit gravity.` },
        { tag: 'ARTISTIC', text: 'The star’s blue-white colour and the compressed distances are visual choices.' },
      ],
      stats: [
        { label: 'G', value: `${U.G * s.env.heavy.gravity}× ours` },
        { label: 'Year on Earth′ (live orbit)', value: year },
        { label: 'Sun′ lifetime (baseline G×4)', value: `~${formatYears(d.sunLifetimeYr)}` },
        ...base.stats.filter((x) => x.label !== 'Gravity (G)'),
      ],
      extraHtml: base.extraHtml,
    };
  }
}
