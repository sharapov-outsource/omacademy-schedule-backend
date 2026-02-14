const config = require("../config");
const { connectMongo } = require("../db");
const { MaxBotStatsRepository } = require("./statsRepository");

// CLI entry point: print MAX bot usage statistics from MongoDB.
(async () => {
  const client = await connectMongo(config.mongoUri);
  try {
    const db = client.db();
    const repository = new MaxBotStatsRepository(db);
    await repository.ensureIndexes();
    const summary = await repository.getSummary();
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.close();
  }
})();
