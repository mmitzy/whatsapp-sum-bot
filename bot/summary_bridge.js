const { spawn } = require('child_process');

function runPythonSummary(pyScriptPath, payload) {
  return new Promise((resolve, reject) => {
    const py = spawn('python', [pyScriptPath, '--summarize'], {
      stdio: ['pipe', 'pipe', 'pipe']
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
