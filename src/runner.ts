import * as fs from 'fs';
import * as path from 'path';

const configPath = 'd:/GitHub/OpenClaw/openclaw.json';
try {
  let apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);
        apiKey = config.bindings?.episodic_memory?.env?.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = apiKey;
    } else {
        console.error(`Config file not found at ${configPath}`);
        // Let's try the other possible path just in case
        const altPath = 'd:/GitHub/OpenClaw Related Repos/openclaw.json';
        if (fs.existsSync(altPath)) {
            const content = fs.readFileSync(altPath, 'utf8');
            const config = JSON.parse(content);
            apiKey = config.bindings?.episodic_memory?.env?.GEMINI_API_KEY;
            process.env.GEMINI_API_KEY = apiKey;
        } else {
             console.error(`Alt Config file not found at ${altPath}`);
             process.exit(1);
        }
    }
  }
  
  if (!process.env.GEMINI_API_KEY) {
      console.error("API Key could not be resolved.");
      process.exit(1);
  }

  // Now run test
  require('./test_sleep_consolidation');
} catch (e) {
  console.error("Failed to load config:", e);
}
