function getActiveUserNames(users) {
  const result = [];
  if (users !== null && users !== undefined) {
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      if (user.active === true) {
        if (user.name !== undefined && user.name !== null) {
          result.push(user.name);
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
  }
  return result;
}

module.exports = { getActiveUserNames };
