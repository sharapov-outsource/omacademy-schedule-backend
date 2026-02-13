const { MongoClient } = require("mongodb");

async function connectMongo(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  return client;
}

module.exports = { connectMongo };
