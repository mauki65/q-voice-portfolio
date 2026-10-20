import type { Participant } from '../shared/types';

declare global {
  interface Window {
    overlay: {
      onParticipants(cb: (participants: Participant[]) => void): void;
      onDragMode(cb: (dragging: boolean) => void): void;
    };
  }
}

/** Fixed slot order so a name never jumps between rows mid-game. */
const ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
const SHORT: Record<string, string> = {
  TOP: 'TOP',
  JUNGLE: 'JGL',
  MIDDLE: 'MID',
  BOTTOM: 'BOT',
  UTILITY: 'SUP',
};

const slots = document.getElementById('slots') as HTMLUListElement;

function shortName(identity: string): string {
  // Drop the tagline: the overlay is glanced at, not read.
  const hash = identity.lastIndexOf('#');
  return hash > 0 ? identity.slice(0, hash) : identity;
}

function render(participants: Participant[]): void {
  const byPosition = new Map(participants.map((p) => [p.position, p]));
  // Anyone without a recognised position (a browser guest, or a mode with no
  // assigned roles) still gets a row — never silently dropped.
  const extras = participants.filter((p) => !ORDER.includes(p.position as (typeof ORDER)[number]));

  slots.innerHTML = '';
  const rows: [string, Participant | undefined][] = ORDER.map((role) => [role, byPosition.get(role)]);
  for (const extra of extras) rows.push(['', extra]);

  for (const [role, person] of rows) {
    const li = document.createElement('li');
    li.className = `slot${person?.inVoice ? ' present' : ''}${person?.speaking ? ' speaking' : ''}`;

    const pip = document.createElement('span');
    pip.className = 'pip';

    const label = document.createElement('span');
    label.className = 'role';
    label.textContent = SHORT[role] ?? '';

    const who = document.createElement('span');
    who.className = 'who';
    // textContent, never innerHTML: these names come off the network.
    who.textContent = person ? shortName(person.identity) : 'open';

    li.append(pip, label, who);
    slots.append(li);
  }
}

window.overlay.onParticipants(render);
window.overlay.onDragMode((dragging) => document.body.classList.toggle('dragging', dragging));

render([]);
