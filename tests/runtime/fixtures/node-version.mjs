// Override only the test child process; production entrypoints never import this fixture.
Object.defineProperty(process.versions, "node", { value: process.env.AGS_TEST_NODE_VERSION });
