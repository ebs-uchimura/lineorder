/**
 * sql.js
 *
 * name：SQL
 * function：SQL operation
 **/

// define modules
const mysql = require('mysql2');

class SQL {

  static pool; // sql pool
  static Object; // result

  // construnctor
  constructor(host, user, pass, db) {
    // DB config
    this.pool = mysql.createPool({
      host: host, // host
      user: user, // username
      password: pass, // password
      database: db, // db name
      insecureAuth: true, // allow insecure
      stringifyObjects: true,
    });
    // result object
    this.obj;
  }

  // getter
  get getValue() {
    // empty
    if (SQL.isEmpty(this.obj)) {
      // return error
      return "error";

    } else {
      // return result
      return this.obj;
    }
  }

  // inquire
  doInquiry = async (sql, inserts) => {
    try {
      // make query
      const qry = mysql.format(sql, inserts);
      // connect ot mysql
      const promisePool = this.pool.promise(); // spread pool
      const [rows, _] = await promisePool.query(qry); // query name
      // result object
      this.obj = rows;

    } catch (e) {
      // error
      console.log(e);
    }
  }

  // empty or not
  static isEmpty(obj) {
    // check whether blank
    return !Object.keys(obj).length;
  }

}

// export module
module.exports = SQL;