// Background thread for song analysis (BPM, beat grid, key, energy, silences, waveform)
import { computeAnalysis } from './analysis-core.js';
self.onmessage = (e) => {
  const { id, job } = e.data;
  try { self.postMessage({ id, result: computeAnalysis(job) }); }
  catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
