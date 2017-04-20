
var steemRemote = require('steem-lib').Remote;
var rippleRemote = require('ripplelib').Remote;
var Seed = require('ripplelib').Seed;

// ========== Validator Setting =========================

// a mongodb url of the database used for storing account ids 
var DB_URL = "mongodb://<username>:<password>@<host:port>/<databaseName>";

// -------------- Accounts  -----------------------------

var SIGNER_ACCOUNT= ""; // ripple address
var SIGNER_KEY = ""; // a privatekey(hex format), or ripple secret(seed)

// ---------------- servers ---------------------------
var steem_opts = {
  servers: [
    "wss://steemd.steemit.com",
    "wss://steemd.steemitdev.com",
  ]
};

var ripple_opts = {
  trusted:        false,
  local_signing:  true,
  local_fee:      false,
  fee_cushion:    1.0,
  max_fee:        1000, // recommeded to be same as Config.fee
  servers: [
    {
        host:    's1.ripple.com'
      , port:    443
      , secure:  true
    },
    {
        host:    's-east.ripple.com'
      , port:    443
      , secure:  true
    },
    {
        host:    's-west.ripple.com'
      , port:    443
      , secure:  true
    }
  ], 
}


// =========== Gateway setting ========================

// Do Not modify any setting in the Config object before 
// getting majority agreement from validators.

Config = {
  steem: new steemRemote(steem_opts),
  ripple: new rippleRemote(ripple_opts),

  signer: SIGNER_ACCOUNT,
  db_url: DB_URL,

  acc_steem: "steemiex", // account on Steemit
  acc_ripple: "r3dpA9FBczceWTWh4FRquuSvEVaQyU3GNg", // operating account on RCL
  acc_msg: "rwXZe6N3YMtKuGkZDjoqeS6KE3am3U7br", // for messaging between signers

  issuer: "rKYyUDK7N4Wd685xjfMeXM9G8xEe5ciVkC", // issuing address of IOUs.
  currency_stm: 'STM', // symbol for issuing STEEM-IOU on RCL
  currency_sbd: 'USD', // symbol for issuing SBD-IOU on RCL

  min_stm: 1, // minimum deposit/withdrawal amount for STEEM
  min_sbd: 1, // minimum deposit/withdrawal amount for SBD

  fee: 1000, // Ripple transaction fee

  fee_stm: 0.001, // deposit & withdrawal fee for STEEM
  fee_sbd: 0.001, // deposit & withdrawal fee for SBD

  timestamp_offset: 2 * 60, // 2min, (for computing ref-block number).

  register_command: 'register', // command for registering dtag.
  update_interval: 10000, // auto-update account settings (eg. signerList) every 10k ledgers.
}

if (SIGNER_ACCOUNT && SIGNER_KEY) {
  if (Seed.is_valid(SIGNER_KEY)) {
    // get privatekey from ripple secret (seed)
    SIGNER_KEY = Seed.from_json(SIGNER_KEY).get_key().to_pri_hex();
  }
  Config.ripple.set_key(SIGNER_ACCOUNT, SIGNER_KEY);
  Config.steem.set_key(SIGNER_ACCOUNT, SIGNER_KEY);
} 

module.exports = Config;