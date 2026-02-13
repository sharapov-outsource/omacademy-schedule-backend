const { MongoClient } = require("mongodb");

// Open a MongoDB client connection and return the connected client instance.
async function connectMongo(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  return client;
}

module.exports = { connectMongo };
