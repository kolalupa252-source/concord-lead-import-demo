import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const sampleCsv = [
  'name,email,source',
  '"Morgan Lee, Northwind Studio",morgan@example.com,Referral',
  'Riley Chen,riley@example.com,Website',
  'Morgan Lee,MORGAN@example.com,Event',
  'Taylor Kim,taylor-at-example.com,Newsletter',
].join('\n');

async function request(path, csv, signal) {
  const response = await fetch(path, csv === undefined ? { signal } : {
    method: 'POST',
    headers: { 'content-type': 'text/csv; charset=utf-8' },
    body: csv,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

function ReviewTable({ result }) {
  return (
    <>
      <dl className="counts">
        {Object.entries(result.counts).map(([status, count]) => (
          <div key={status}>
            <dt>{status}</dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Row</th><th>Lead</th><th>Result</th></tr></thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.line}>
                <td>{row.line}</td>
                <td>
                  {row.name || '—'}
                  {row.email && <small>{row.email}</small>}
                  {row.source && <small>{row.source}</small>}
                </td>
                <td>
                  <span className={`status ${row.status}`}>{row.status}</span>
                  {row.reason && <small>{row.reason}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function App() {
  const [csv, setCsv] = useState(sampleCsv);
  const [result, setResult] = useState(null);
  const [leads, setLeads] = useState(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [committed, setCommitted] = useState(false);

  async function loadLeads(signal) {
    try {
      setLeads((await request('/api/leads', undefined, signal)).leads);
      setLoadError('');
    } catch (failure) {
      if (failure.name !== 'AbortError') setLoadError(failure.message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadLeads(controller.signal);
    return () => controller.abort();
  }, []);

  function editCsv(value) {
    setCsv(value);
    setResult(null);
    setCommitted(false);
    setMessage('');
    setError('');
  }

  async function run(mode) {
    setPending(mode);
    setError('');
    setMessage('');
    try {
      const outcome = await request(`/api/import/${mode}`, csv);
      setResult(outcome);
      if (mode === 'commit') {
        setCommitted(true);
        setMessage(`Saved ${outcome.inserted} ${outcome.inserted === 1 ? 'lead' : 'leads'}.`);
        await loadLeads();
      } else {
        setCommitted(false);
        setMessage('Preview updated.');
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setPending('');
    }
  }

  return (
    <main>
      <header className="page-header">
        <h1>Lead Import Review</h1>
        <p>Review a CSV, then save eligible leads to the local database.</p>
      </header>
      <div className="workspace">
        <section className="panel" aria-labelledby="csv-title">
          <div className="panel-heading">
            <h2 id="csv-title"><label htmlFor="csv">CSV input</label></h2>
            <button className="subtle" onClick={() => editCsv(sampleCsv)} disabled={Boolean(pending)}>
              Load example
            </button>
          </div>
          <p id="csv-hint">Use the <code>name</code>, <code>email</code>, and <code>source</code> columns.</p>
          <textarea
            id="csv"
            aria-describedby="csv-hint"
            value={csv}
            onChange={(event) => editCsv(event.target.value)}
            disabled={Boolean(pending)}
            spellCheck={false}
          />
          <div className="actions">
            <button onClick={() => run('preview')} disabled={Boolean(pending) || !csv.trim()}>
              {pending === 'preview' ? 'Checking…' : 'Preview import'}
            </button>
            <button
              className="primary"
              onClick={() => run('commit')}
              disabled={Boolean(pending) || committed || !result?.counts.ready}
            >
              {pending === 'commit' ? 'Saving…' : 'Save eligible leads'}
            </button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="feedback" role="status">{message}</p>
        </section>
        <section className="panel" aria-labelledby="review-title">
          <h2 id="review-title">Row review</h2>
          {result ? <ReviewTable result={result} /> : <p>Run a preview to see which rows can be saved.</p>}
        </section>
      </div>
      <section className="panel saved" aria-labelledby="saved-title">
        <h2 id="saved-title">Saved leads{leads !== null && ` (${leads.length})`}</h2>
        {loadError && <p role="alert" className="error">{loadError}</p>}
        {leads === null && !loadError && <p>Loading saved leads…</p>}
        {leads?.length === 0 && <p>Your first import will appear here.</p>}
        {Boolean(leads?.length) && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Source</th></tr></thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.email}><td>{lead.name}</td><td>{lead.email}</td><td>{lead.source || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
