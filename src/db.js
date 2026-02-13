const { MongoClient } = require("mongodb");

/**
 * Open a MongoDB client connection.
 *
 * @param {string} uri
 * @returns {Promise<import("mongodb").MongoClient>}
 */
async function connectMongo(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  return client;
}

module.exports = { connectMongo };
