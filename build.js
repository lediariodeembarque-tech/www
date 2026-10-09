import fs from 'node:fs';

if (!fs.existsSync('./index.html')) {
  console.error('Error: index.html not found');
  process.exit(1);
}

console.log('Build completed successfully: index.html verified.');
