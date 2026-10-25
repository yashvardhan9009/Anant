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
    return {
      title: U.name,
      mode: 'HYPOTHETICAL UNIVERSE',
      subtitle: `${U.premise} Planets orbit ${d.orbitalSpeed.toFixed(0)}× faster; a year on Earth′ lasts ${d.earthYearDays.toFixed(0)} days.`,
      accuracy: [
        { tag: 'HYPOTHETICAL', text: `Not our universe. G here is ${U.G}× the measured value — a "what if", not an observation.` },
        { tag: 'SIMULATION', text: 'The same Newtonian N-body integrator as our Cosmos, run with the stronger G. Orbits, periods and energy are computed live.' },
        { tag: 'MODEL', text: `Star brightness from stellar homology (L ∝ G⁴M³): about ${d.luminosity}× brighter, burning out in ~${formatYears(d.sunLifetimeYr)} instead of ~10 billion. Order-of-magnitude only.` },
        { tag: 'ARTISTIC', text: 'The star’s blue-white colour and the compressed distances are visual choices.' },
      ],
      stats: [
        { label: 'G', value: `${U.G * s.env.heavy.gravity}× ours` },
        { label: 'Year on Earth′', value: `${d.earthYearDays.toFixed(0)} days` },
        { label: 'Sun′ lifetime', value: `~${formatYears(d.sunLifetimeYr)}` },
        ...base.stats.filter((x) => x.label !== 'Gravity (G)'),
      ],
      extraHtml: base.extraHtml,
    };
  }
}
