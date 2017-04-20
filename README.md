A Nodejs app for running Steemiex validators.

Steemiex is a M-of-N multi-sign gateway that's bridging RCL and Steem blockchain. All the deposits/withdrawals can only be processed with majority agreement from the signers/validators.

---

## Pre-requisite

An instance of mongodb database, for storing a map of Steem `id` <-> `account`.

All existing Steem id-account pairs should be imported into the database before starting a Steemiex-node. (see `docs/database.md` for details).

---

## Installation 

1. clone this repository.
2. browse into the app directory, run `npm install`.
3. edit the `config.js` file for your own validator: 
    * DB_URL: the url of a mongodb database.
    * SIGNER_ACCOUNT: Ripple-address of the validator
    * SIGNER_KEY: signing-key (secret/private) of the validator
    * other parameters, e.g. urls of Ripple servers and Steem nodes being used.

  

## Run
`node app.js` or `npm start`.

---

## Documentation
See the `docs` folder.
