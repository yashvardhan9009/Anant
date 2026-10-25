import './ui/style.css';
import { App } from './App';

const curtain = document.createElement('div');
curtain.className = 'curtain';
curtain.innerHTML = `<div class="c">
  <svg viewBox="0 0 160 80" aria-hidden="true"><path d="M20 40c0-16 20-24 40 0s40 16 40 0-20-24-40 0-40 16-40 0" fill="none" stroke="#7df9ff" stroke-width="4"/></svg>
  <h1>ANANT</h1><h2>EXPERIENCE THE IMPOSSIBLE.</h2><div class="enter">CLICK OR PRESS ANY KEY TO ENTER</div></div>
  <div class="note">Best with sound. Hand tracking is optional (✋). Your camera never leaves this device.</div>`;
document.body.append(curtain);

const app = new App();
app.boot().catch((e) => {
  console.error(e);
  app.hud.system(`Boot problem: ${e.message}`, 'fail');
});

const enter = () => {
  if (curtain.classList.contains('gone')) return;
  curtain.classList.add('gone');
  app.audio.start();
  app.audio.ambience(app.state.activeRealm);
  setTimeout(() => curtain.remove(), 1300);
  removeEventListener('keydown', enter);
};
curtain.addEventListener('click', enter);
addEventListener('keydown', enter);
// Automated tests can skip the curtain with ?skipIntro
if (new URLSearchParams(location.search).has('skipIntro')) enter();
