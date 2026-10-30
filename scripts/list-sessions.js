'use strict';
// Prints the exact session ids that project-board.json assigns to projects.
// Reads the running Tower's own local feed; changes nothing.
const PORT = Number(process.env.TOWER_PORT || 4433);

const titleOf = row => String(row.fullTitle || row.title || '').replace(/\s+/g, ' ').trim();

// A pasted title often carries extra spaces or line breaks; match on words, not layout.
function matchingRows(sessions, filter = '') {
  const query = String(filter).replace(/\s+/g, ' ').trim().toLowerCase();
  return (Array.isArray(sessions) ? sessions : [])
    .filter(row => row && typeof row.id === 'string')
    .filter(row => !query || titleOf(row).toLowerCase().includes(query))
    .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));
}

function formatRows(sessions, filter = '') {
  return matchingRows(sessions, filter).map(row => [row.id, row.agent === 'claude' ? 'Claude' : 'Codex', titleOf(row)].join('\t'));
}

// The ids as one line, ready to paste between the brackets of "sessionIds": [ ].
function pasteLine(sessions, filter = '') {
  return matchingRows(sessions, filter).map(row => JSON.stringify(row.id)).join(', ');
}

async function main(filter) {
  let data;
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/sessions', {headers:{accept:'application/json'}});
    data = await res.json();
  } catch {
    console.error('Tower is not answering on port ' + PORT + '. Start it with npm start, then try again.');
    process.exitCode = 1;
    return;
  }
  const lines = formatRows(data.sessions, filter);
  if (!lines.length) { console.log(filter ? 'No sessions match "' + filter + '".' : 'No sessions yet. Open or resume a conversation, then try again.'); return; }
  console.log('id\tapp\ttitle');
  for (const line of lines) console.log(line);
  if (filter) console.log('\nPaste between the brackets of that project\'s "sessionIds": [ ]\n' + pasteLine(data.sessions, filter));
}

if (require.main === module) main(process.argv.slice(2).join(' '));
module.exports = { formatRows, pasteLine };
