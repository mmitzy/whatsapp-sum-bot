// bot/summary_bridge.js
const { spawn } = require('child_process');
const path = require('path');

function runPythonSummary(pyScriptPath, payload) {
  return new Promise((resolve, reject) => {
    // Use venv python so packages are found
    const pythonExe = path.join(__dirname, '..', 'venv', 'Scripts', 'python.exe');

    const py = spawn(pythonExe, [pyScriptPath, '--summarize'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });


    let out = '';
    let err = '';

    py.stdout.on('data', (d) => (out += d.toString()));
    py.stderr.on('data', (d) => (err += d.toString()));

    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(`python exited ${code}\n${err}`));
      resolve(out.trim());
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}

module.exports = { runPythonSummary };
