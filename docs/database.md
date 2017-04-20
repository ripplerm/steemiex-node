## Overview

Steemiex-node use a (mongodb) database to store a map of steem `id - account`. The main usage of this database is to fascillitate the withdrawals process.  

There are two reasons for the need of this db:

* Most of the ripple wallet-clients out there currently has no support for memo.  
  Hence, to enable ordinary end-users to perform withdrawals easily, instead of memo we had to provide an alternative method, which is by using destination-tag (a feature supported by most ripple-clients). 

* The most convenient way of doing this, is to use the ID of a Steem account as the destination-tag when a user wanted to make a withdrawal. However, amongs the currently available Steemd APIs, we couldn't find a way to make a query of `id` --> `account`. Thus come the workaround to import the account-id pair into our own databse for the use of steemiex-nodes.
 
Should any of the above obstacles get solved in future, a steemiex-nodes will no longer need to maintain its own `id - account` database.

---
## Import

Before initialising a steemiex-node, you need to import all existing Steem `account-id` pairs into `users` collection of the database. Each document in the collection contains two fields: 
* `name` for account's name, 
* `id` for the account's id.

There's a running instance at `mongodb://demo1:123456@ds161960.mlab.com:61960/steemiex`, from which you can dump/export a recently-updated `users` collection (currently ~20MB size),
```
mongoexport.exe -h ds161960.mlab.com:61960 -d steemiex -c users -u demo1 -p 123456 -o steemiex_users.json
```
then import/restore the collection to your own:
```
mongoimport.exe -h <yourhost:port> -d <yourdb> -c users -u <username> -p <password> --drop --file steemiex_users.json
```

#### Auto-updates
When steemiex-node is up and running, it will periodically scan the Steem blockchain for new accounts, and import them into the database. There's also a _counter_ document in the `users` collection, for tracing the last point of this auto-import process.

---

## Others
By default, steemiex-node will also store processed transactions in a collection named `transactions`. This is for the purpose of easier reference in future (so that we don't need to query RCL/Steem blockchain for transaction history). This records are not mandatory for running a steemiex-node, and it could be turned-off by setting `SAVE_TXNS` = false, in `db.js`.
