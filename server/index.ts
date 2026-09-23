// Same precedence as Next.js: .env.local wins over .env, and real environment
// variables win over both (loadEnvFile never overwrites an existing value).
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing env files are fine; production sets variables directly.
  }
}

const port = Number(process.env.API_PORT || 4000);

// Imported after the env files load so modules see the configured values.
import("./app").then(({ createApp }) => {
  createApp().listen(port, () => {
    console.info(`AnaAI API listening on http://localhost:${port}`);
  });
});
