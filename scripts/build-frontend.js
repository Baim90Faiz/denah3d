const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const outputDirectory = path.join(projectRoot, 'dist');

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });
fs.copyFileSync(path.join(projectRoot, 'index.html'), path.join(outputDirectory, 'index.html'));
fs.cpSync(path.join(projectRoot, 'public'), path.join(outputDirectory, 'public'), { recursive: true });
