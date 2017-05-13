
var UInt160 = require('ripplelib').UInt160;
var RippleUtils = require('ripplelib').utils;
var RippleTransaction = require('ripplelib').Transaction;
var PublicKey = require('steem-lib').PublicKey;

var Config = require('./config');
var Deposits = require('./deposits');
var Withdrawals = require('./withdrawals');
var DB = require('./db');

var fs = require('fs');

// ==========================================================

// for gateway -> users transactions (deposits, withdrawals, etc.)
var MEMOTYPE = 'gateway';  
var MEMOFORMAT = 'text/json';

// for messages between delegates/signers;
var MEMOTYPE_MSG = 'msg';
var MEMOFORMAT_MSG = '1.0.0';

// ===========================================================
function Gateway (opts) {
	// overwrite Config with opts
	Object.assign(Config, opts);

	this.steem = Config.steem;
	this.ripple = Config.ripple;

	this.db = new DB(Config.db_url);
	this.deposits = new Deposits(this);
	this.withdrawals = new Withdrawals(this);

	this.issuer_txns = new Deposits(this); // for updating issuing account signerlist

	this.ripple.connect(function () {
 		console.log('connected to Ripple-Network');
 	})

	this.ripple.on('error', function () {
		console.log('Ripple Remote Error, Try Reconnecting...')
		self.ripple.reconnect();
	})

 	this.steem.connect(function () {
 		console.log('connected to Steem-Network.')
 	})

	return this;
}

Gateway.prototype.loadSignerList = function (callback) {
	if (typeof callback !== 'function') callback = function () {};
	var self = this;
	this.steem.getAccounts([Config.acc_steem], function (err, res) {
		if (!res || !res[0]) throw "Failed to load signerList";
		var meta;
		try { meta = JSON.parse(res[0].json_metadata)} catch (e) {}
		if (!meta || !meta.signerList) throw "Failed to load signerList";
		self.signerList = meta.signerList;
		fs.writeFile('signers.txt', JSON.stringify(self.signerList, null, "  "))
		callback();
	})
}

Gateway.prototype.init = function (opts) {
	var self = this;

	if (! this.signerList) {
		this.loadSignerList(function () {
			self.init(opts)
		})
		return;
	}

 	// get a ref_block.
 	this.steem.once('block_advanced', function (blockNum) {
 		self._getBlock(blockNum);
 	})

	this._autoUpdateSettings();

	this.getLastDepositId(Config.issuer, function (err, res) {
		if (err || !res) throw err;
		self.issuer_next_seq = res.next_seq;
		self.issuer_txns.setLastId(res.id);

		var account = self.ripple.account(Config.acc_ripple);

		if (opts && opts.immediate) {
			// start listening immediately from current ledger/block
			// (for debugging use)
			account.getInfo(function (err, res) {
				if (err) throw err;
				data = res.account_data;
				self.next_seq = data.Sequence;
				self.listenMessage();
				self.listenWithdrawal();
				self.listenDeposit();
			});
		} else {
			//start listening from the last processed deposit & withdrawal.
			self.getLastDepositId(Config.acc_ripple, function (err, res) {
				if (err) throw err;
				var deposit_id = res.id;
				var next_seq = res.next_seq;
				self.deposits.setLastId(deposit_id);
				var num = parseInt(deposit_id.slice(0,8), 16);
				console.log('last Deposit Block_num:', num);

				self.getLastWithdrawalId(function (err, id) {
					if (err) throw err;
					self.withdrawals.setLastId(id);
					var ledger_index = parseInt(id.slice(0,8), 16);
					console.log('last withdrawal ledger_index:', ledger_index);

					self.next_seq = next_seq;
					self.listenMessage(ledger_index);
					self.listenWithdrawal(ledger_index);
					self.listenDeposit(deposit_id);
				});			
			});
		}
	})
}

Gateway.prototype.getLastWithdrawalId = function (callback) {
	var self = this;
	if (typeof callback !== 'function') callback = function () {};

	function getSteemHistory (from) {
		var acc = Config.acc_steem;
		console.log('getting steem history...')
		self.steem.getAccountHistory(acc, from, 20, function (err, res) {
			if (err) return callback(err);
			for (var i = res.length - 1; i >= 0;  i--) {
				var type = res[i][1].op[0];
				var data = res[i][1].op[1];
				if (type === 'transfer' && data.from === acc) {
					var id;
					try {
						var memo = JSON.parse(data.memo);
						if (typeof memo.id === 'string' && memo.id.length === 16) id = memo.id;
					} catch (e) {};
					if (id) return callback(null, id);
				}
			}
			getSteemHistory(res[0][0] - 1);
		})					
	}
	getSteemHistory(-1);
}

Gateway.prototype.getLastDeposit = function (account, callback) {
	var self = this;
	if (typeof callback !== 'function') callback = function () {};

	var opts = {
	    account: account,
	    ledger_index_min: -1,
	    ledger_index_max: -1,
	    binary: true,
	    parseBinary: true,
	    limit: 20, 
	}
	function handleResponse (err, res) {
		if (err) return callback(err);
		if (res && res.transactions) {
			for (var i=0, l=res.transactions.length; i<l; i++) {
				var tx = res.transactions[i].tx;
				if (tx.Account !== account || !tx.Memos) continue;
				var d = undefined;
				try {
					d = RippleUtils.hexToString(tx.Memos[0].Memo.MemoData);
					d = JSON.parse(d);
				} catch (e) {};
				if (d && (typeof d.id === 'string') && d.id.length == 24) {
					return callback(null, {seq:tx.Sequence, id: d.id});
				}
			}
			if (!res.marker) return callback('Error');
			opts.marker = res.marker;
			self.ripple.requestAccountTx (opts, handleResponse);
		}
	}
	this.ripple.requestAccountTx(opts, handleResponse);
}

Gateway.prototype.getLastDepositId = function (account, callback) {
	if (typeof callback !== 'function') callback = function () {};
	if (typeof account !== 'string') throw 'Invalid Account';

	var self = this;

	this.ripple.requestAccountInfo({account: account, ledger:'validated'}, function (err, res) {
		if (err || !res) throw err;

		var data = res.account_data;
		var tx_hash = data.AccountTxnID; // will it be better to use data.PreviousTxnID ??

		self.ripple.requestTransaction({hash: tx_hash}, function (err, res){
			if (err || !res) return callback('Error');
			if (res.Sequence !== data.Sequence - 1) {
				console.log('Warning: Sequence Gap for account', account);
			}
			if (res.Memos && res.Memos[0].Memo.MemoData){
				var d;
				try {
					d = JSON.parse(RippleUtils.hexToString(res.Memos[0].Memo.MemoData));
				} catch (e) {};
				if (d && typeof d.id === 'string' && d.id.length == 24) {
					return callback(null, {seq: res.Sequence, id: d.id, next_seq: data.Sequence});
				} else {
					self.getLastDeposit(account, function (e, r) {
						if (r) r.next_seq = data.Sequence;
						callback(e,r);
					});
				}
			} else {
				self.getLastDeposit(account, function (e, r) {
					if (r) r.next_seq = data.Sequence;
					callback(e,r);
				});
			}
		})
	})
}

Gateway.prototype._autoUpdateSettings = function () {
	var self = this;
	this.ripple.on('ledger_closed', function (ledger){
		var ledger_index = ledger.ledger_index;
		if (ledger_index % Config.update_interval == 0) self.signerSetSteem(ledger_index);
		if (ledger_index % Config.update_interval == 10) self.accountSetQueue(ledger_index);
		if (ledger_index % Config.update_interval == 20) self.trustSetQueue(ledger_index, Config.currency_stm);
		if (ledger_index % Config.update_interval == 21) self.trustSetQueue(ledger_index, Config.currency_sbd);
	})

	var acc = this.steem.addAccount(Config.acc_steem);
	acc.on('account_update', function (trx) {
		self.signerSetRipple(trx);
		self.signerSetIssuer(trx);
	});
}

Gateway.prototype.accountSetQueue = function (ledger_index) {
	var data;
	try { 
		data = JSON.parse(fs.readFileSync('accountset_proposed.txt', 'utf8'))
	} catch (e) {};
	if (typeof data != 'object') return;

	var id = this.withdrawals.add(ledger_index, 'account-set-queue');
	if (!id) return;

	console.log('=== AccountSet Queue ===')

	var memo = {
		type: 'account-set-issuer',
	}

	var fields = ['Domain', 'EmailHash', 'MessageKey', 'TransferRate', 'SetFlag', 'ClearFlag']
	fields.forEach(function (field) {
		if (data.hasOwnProperty(field)) {
			memo[field] = data[field];
		}
	})

	var opts = {
	    from: Config.acc_steem,
	    to: Config.acc_steem,
	    amount: "0.001 STEEM",
	    memo: JSON.stringify(memo)
	}

	var stx = this.steem.transaction();
	stx.add_operation("transfer", opts);

	var self = this;
	this.getReferenceBlockByLedgerNum(ledger_index, function (err, res) {
		var block = res;
		if (!block) {
			console.log('Error: No Reference Block');
			return;	
		} 
		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;

		stx.complete();
		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');

		var msg = {
			type: 'virtual',
			id: id,
			sig: sig_hex,
		}

		self.withdrawals.addTransaction(id, stx);
		self.sendMessage(msg);
	});
}

Gateway.prototype.trustSetQueue = function (ledger_index, currency) {
	if (currency != Config.currency_stm && currency != Config.currency_sbd) return;

	var data;
	try { 
		data = JSON.parse(fs.readFileSync('trusts_proposed.txt', 'utf8'))
	} catch (e) {};

	if ((typeof data != 'object') || (typeof data[currency] != 'number')) return;

	var id = this.withdrawals.add(ledger_index, 'trust-set-queue');
	if (!id) return;

	console.log('=== TrustSet Queue', currency, '===');

	var memo = {
		type: 'trust-set-issuer',
		currency: currency,
		value: data[currency]
	}
	var opts = {
	    from: Config.acc_steem,
	    to: Config.acc_steem,
	    amount: "0.001 STEEM",
	    memo: JSON.stringify(memo)
	}

	var stx = this.steem.transaction();
	stx.add_operation("transfer", opts);

	var self = this;
	this.getReferenceBlockByLedgerNum(ledger_index, function (err, res) {
		var block = res;
		if (!block) {
			console.log('Error: No Reference Block');
			return;	
		} 
		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;

		stx.complete();
		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');

		var msg = {
			type: 'virtual',
			id: id,
			sig: sig_hex,
		}

		self.withdrawals.addTransaction(id, stx);
		self.sendMessage(msg);
	});
}

Gateway.prototype.trustSet = function (data, operation) {
	if (typeof data != 'object' || typeof data.value != 'number') return;
	if (data.currency != Config.currency_stm && data.currency != Config.currency_sbd) return;

	var id = this.issuer_txns.add(operation, 'trust-set-issuer');
	if (!id) return;

	console.log('=== Ripple TrustSet', data.currency, '===');

	var seq = this.issuer_next_seq++;

	var transaction = this.ripple.transaction();

	transaction.tx_json.TransactionType = 'TrustSet';
	transaction.tx_json.Account = Config.issuer;
    transaction.tx_json.Sequence = seq;
	transaction.tx_json.Fee = Config.fee * (this.signerList.quorum + 1);
	transaction.tx_json.SigningPubKey = '';

	transaction.tx_json.LimitAmount = {
		currency: data.currency,
		issuer: Config.acc_ripple,
		value: data.value,
	}

    var memotype = MEMOTYPE;
    var memoformat = MEMOFORMAT;
	var memodata = JSON.stringify({
	  id: id
	});

	transaction.tx_json.Memos = [ {
	      Memo : {
	                MemoType : RippleUtils.stringToHex(memotype),
	                MemoFormat: RippleUtils.stringToHex(memoformat),
	                MemoData : RippleUtils.stringToHex(memodata)
	             }
	} ];  

    transaction.tx_json.Flags = 0x80000000;
	transaction._multisign = true;
	transaction._multiSign = true;
	transaction._signerNum = this.signerList.quorum;

	transaction._complete = true;		//skip auto-fill process
	transaction._setFixedFee = true;	//avoid fee adjust
	transaction._setLastLedger = true;	//skip auto-fill lastledger

	var signer = transaction.getSignatureFor(Config.signer);

	this.issuer_txns.addTransaction(id, transaction)

	var msg = {
		type: 'trust-set-issuer',
		id: id,
		sig: signer,
	}
	this.sendMessage(msg);
}

Gateway.prototype.signerSetSteem = function (ledger_index) {
	var signerList;
	try{
		signerList = JSON.parse(fs.readFileSync('signers_proposed.txt', 'utf8'));
	} catch (e) {};
	if (! signerList) return console.log('=== SignerList Unchanged ===');

	if (JSON.stringify(signerList) === JSON.stringify(this.signerList)) {
		return console.log('=== SignerList Unchanged ===');
	}
	console.log('=== SignerSet Steem ===', ledger_index)

	var id = this.withdrawals.add(ledger_index, 'signer-set-steem');
	if (!id) return;

	var stx = this.steem.transaction();

	var keys = [];
	for (var signer in signerList.signers) {
		var s = signerList.signers[signer];
		keys.push([
			PublicKey.fromHex(s.pubkey).toString(), 
			s.weight
		]);
	}
	var auth = {
	    weight_threshold: signerList.quorum,
	    account_auths: [],
	    key_auths: keys,		
	}
	var metadata = {
		signerList: signerList,
	};
	var opts = {
		account: Config.acc_steem,
		owner: auth,
		active: auth,
		posting: auth,
		memo_key: PublicKey.fromHex(signerList.memo_key).toString(),
		json_metadata: JSON.stringify(metadata)
	}
	stx.add_type_operation("account_update", opts);

	var self = this;
	this.getReferenceBlockByLedgerNum(ledger_index, function (err, res) {
		var block = res;
		if (!block) {
			console.log('Error: No Reference Block');
			return;	
		} 
		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;

		stx.complete();
		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');

		var msg = {
			type: 'signer-set-steem',
			id: id,
			sig: sig_hex,
		}

		self.withdrawals.addTransaction(id, stx);
		self.sendMessage(msg);
	});
}

Gateway.prototype.signerSetRipple = function (trx) {
	var op_id = this.deposits.add(trx, 'signer-set-ripple');
	if (!op_id) return;

	var op = trx.op[1];
	var meta;
	try {
		meta = JSON.parse(op.json_metadata);	
	} catch (e) {}
	if (!meta || !meta.signerList) return;

	var sl = meta.signerList;
	var signers = sl.signers;
	var quorum = sl.quorum;
	if (!signers || !quorum) return;

	this.deposits.get(op_id).signerList = sl;

	console.log('=== SignerSet Ripple ===');
	var seq = this.next_seq++;

	var SignerEntries = [];
	for (var signer in signers) {
		var SignerEntry = {
			Account: signer,
			SignerWeight: signers[signer].weight
		}
		SignerEntries.push({SignerEntry: SignerEntry})
	}

	var transaction = this.ripple.transaction();
	transaction.tx_json.TransactionType = 'SignerListSet';
	transaction.tx_json.Account = Config.acc_ripple;

	transaction.tx_json.SignerQuorum = quorum;
	transaction.tx_json.SignerEntries = SignerEntries;

	transaction.tx_json.Sequence = seq;
	transaction.tx_json.Fee = Config.fee * (this.signerList.quorum + 1);
	transaction.tx_json.SigningPubKey = '';;

    var memotype = MEMOTYPE;    
    var memoformat = MEMOFORMAT;
    var memodata = JSON.stringify({
    	id: op_id,
    });

	transaction.tx_json.Memos = [ {
	      Memo : {
	                MemoType : RippleUtils.stringToHex(memotype),
	                MemoFormat: RippleUtils.stringToHex(memoformat),
	                MemoData : RippleUtils.stringToHex(memodata)
	             }
	} ];  

    transaction.tx_json.Flags = 0x80000000;
	transaction._multisign = true;
	transaction._multiSign = true;
	transaction._signerNum = this.signerList.quorum;

	transaction._complete = true;		//skip auto-fill process
	transaction._setFixedFee = true;	//avoid fee adjust
	transaction._setLastLedger = true;	//skip auto-fill lastledger

	var signer = transaction.getSignatureFor(Config.signer);

	this.deposits.addTransaction(op_id, transaction)

	var msg = {
		type: 'signer-set-ripple',
		id: op_id,
		sig: signer,
	}

	this.sendMessage(msg);
}

Gateway.prototype.signerSetIssuer = function (trx) {
	var op_id = this.issuer_txns.add(trx, 'signer-set-issuer');
	if (!op_id) return;

	var op = trx.op[1];
	var meta;
	try {
		meta = JSON.parse(op.json_metadata);	
	} catch (e) {}
	if (!meta || !meta.signerList) return;

	var sl = meta.signerList;
	var signers = sl.signers;
	var quorum = sl.quorum;
	if (!signers || !quorum) return;

	this.issuer_txns.get(op_id).signerList = sl;

	console.log('=== SignerSet Issuer ===');
	var seq = this.issuer_next_seq++;

	var SignerEntries = [];
	for (var signer in signers) {
		var SignerEntry = {
			Account: signer,
			SignerWeight: signers[signer].weight
		}
		SignerEntries.push({SignerEntry: SignerEntry})
	}

	var transaction = this.ripple.transaction();
	transaction.tx_json.TransactionType = 'SignerListSet';
	transaction.tx_json.Account = Config.issuer;

	transaction.tx_json.SignerQuorum = quorum;
	transaction.tx_json.SignerEntries = SignerEntries;

	transaction.tx_json.Sequence = seq;
	transaction.tx_json.Fee = Config.fee * (this.signerList.quorum + 1);
	transaction.tx_json.SigningPubKey = '';;

    var memotype = MEMOTYPE;    
    var memoformat = MEMOFORMAT;
    var memodata = JSON.stringify({
    	id: op_id,
    });

	transaction.tx_json.Memos = [ {
	      Memo : {
	                MemoType : RippleUtils.stringToHex(memotype),
	                MemoFormat: RippleUtils.stringToHex(memoformat),
	                MemoData : RippleUtils.stringToHex(memodata)
	             }
	} ];  

    transaction.tx_json.Flags = 0x80000000;
	transaction._multisign = true;
	transaction._multiSign = true;
	transaction._signerNum = this.signerList.quorum;

	transaction._complete = true;		//skip auto-fill process
	transaction._setFixedFee = true;	//avoid fee adjust
	transaction._setLastLedger = true;	//skip auto-fill lastledger

	var signer = transaction.getSignatureFor(Config.signer);

	this.issuer_txns.addTransaction(op_id, transaction)

	var msg = {
		type: 'signer-set-issuer',
		id: op_id,
		sig: signer,
	}

	this.sendMessage(msg);
}


Gateway.prototype._getBlock = function (blockNum, callback) {
	if (typeof callback !== 'function') callback = function () {};
	var self = this;
	var opts = {
		blockNum: blockNum,
		broadcast:  function (res, server) { return (res && res.previous && server._properties.last_irreversible_block_num >= blockNum) }
	};
	this.steem.getBlockWith(opts, function (err, block){
		if (err) return callback(err);
		block.block_num = blockNum;
		block.timestamp_sec = Math.ceil(new Date(block.timestamp).getTime() / 1000);
		self._ref_block = block;
		callback(null, block)
	})
}

Gateway.prototype.getReferenceBlockByNum = function (blockNum, callback) {
	if (typeof callback !== 'function') callback = function (){};
	var self = this;

	if (! Number.isFinite(blockNum)) throw 'Invalid blockNum';

	if (blockNum > this.steem.last_irreversible_block_num) {
		this.steem.once('block_advanced', function(){
			self.getReferenceBlockByNum(blockNum, callback);
		})
		return;	
	}

	this._getBlock(blockNum, function (err, res) {
		if (err || !res) return callback('Failed requesting block #' + blockNum, null);
		callback(null, res)
	})
}

Gateway.prototype.getReferenceBlockByTimestamp = function (timestamp_sec, callback) {
	var self = this;

	if (! this._ref_block) {
		this.steem.once('block_advanced', function(){
			self.getReferenceBlockByTimestamp(timestamp_sec, callback);
		})
		return;
	}

	var ref_block = this._ref_block;
	var num = Math.ceil(ref_block.block_num + ((timestamp_sec - ref_block.timestamp_sec) / 3));

	var num_lib = this.steem.last_irreversible_block_num;
	if (num > num_lib) {
		this.steem.once('block_advanced', function(){
			self.getReferenceBlockByTimestamp(timestamp_sec, callback);
		})
		return;	
	}

	while (num_lib - num > 1200) {
		// reference_block should not older than 1 hour.
		num += 1200;
	}

	function getBlock () {
		self.getReferenceBlockByNum(num, function (err, block){
			if (err) { 
				console.log(err)
			} else if (block) {
				if (typeof block.timestamp_sec !== 'number') throw 'No timestamp';
				//check (previous_block_timestamp < timestamp <= block_timestamp)
				if (block.timestamp_sec < timestamp_sec) {
					num++;
					return getBlock();
				} else {
					self.getReferenceBlockByNum(num - 1, function (err, block_previous){
						if (err) return console.log(err);
						if (typeof block_previous.timestamp_sec !== 'number') throw 'No timestamp';
						if (block_previous.timestamp_sec < timestamp_sec) {
							callback(null, block);
						} else {
							num--;
							return getBlock();
						}
					});
				}
			}
		});
	}

	getBlock();
}

Gateway.prototype.getReferenceBlockByLedgerNum = function (ledger_index, callback) {
	if (typeof callback !== 'function') callback = function (){};
	var self = this;

	this.ripple.requestLedger({ledger_index: ledger_index}, function(err, res){
		if (err) return callback(err);
		var timestamp = RippleUtils.toTimestamp(res.ledger.close_time) / 1000;	
		timestamp -= Config.timestamp_offset;
		if (! timestamp) return callback('No ledger_closed_time.');
		self.getReferenceBlockByTimestamp(timestamp, callback)
	})
}

// determine the ref_block to be use for constructing Steem txn,
// from the relevant RCL-txn (withdrawals).
Gateway.prototype.getReferenceBlockForRippleTx = function (tx, callback) {
	if (typeof callback !== 'function') callback = function (){};
	var self = this;

	if (tx.tx_json.date) {
		var timestamp = RippleUtils.toTimestamp(tx.tx_json.date) / 1000;
		timestamp -= Config.timestamp_offset;
		this.getReferenceBlockByTimestamp(timestamp, callback);
	} else if (tx.tx_json.ledger_index){
		this.getReferenceBlockByLedgerNum(tx.tx_json.ledger_index, callback);
	} else {
		callback('No source of timestamp.');
	}
}

Gateway.prototype.toSteemAmount = function (amount_obj) {
	value = amount_obj.value;
	currency = amount_obj.currency;

	if (currency == Config.currency_stm) currency = 'STEEM';
	else if (currency == Config.currency_sbd) currency = 'SBD';

	return Number(value).toFixed(3) + ' ' + currency;
}

Gateway.prototype.parseSteemAmount = function (amount) {
	var value = amount.split(' ')[0];
	var currency = amount.split(' ')[1];

	if (currency == 'STEEM') currency = Config.currency_stm;
	if (currency == 'SBD') currency = Config.currency_sbd;

	return {value: value, currency: currency};
}

Gateway.prototype.validateDepositAmount = function (operation) {
	var amount = this.parseSteemAmount(operation.amount);

	if (!(amount.currency == Config.currency_stm || amount.currency == Config.currency_sbd)) {
		return false;
	}
	var minimum = (amount.currency == Config.currency_stm) ? Config.min_stm : Config.min_sbd;
	if (Number(amount.value) < minimum) return false;

	return true;
}

Gateway.prototype.validateRecipient = function (memo) {
	if (!memo) return false;
	data = memo.split(/\W+/);

	var account = data[0];
	if (account[0] !== 'r' || !UInt160.is_valid(account)) return false;	

	var dtag = data[1];
	if (!dtag) return true; //valid address without dtag

    if (/^\d+$/.test(dtag)) { 
        var value = Number(dtag);  
        if (value >= 0 && value <= 4294967295) return true;
    }
    return false;
}

Gateway.prototype.validateRippleAmount = function (tx) {
	var amount = tx.metadata.delivered_amount;
	if (typeof amount != 'object') return false; 
	if ([Config.currency_stm, Config.currency_sbd].indexOf(amount.currency) < 0) return false;

	var minimum = (amount.currency == Config.currency_stm) ? Config.min_stm : Config.min_sbd;
	if (Number(amount.value) < minimum) return false;

	return true;	
}

Gateway.prototype.validateDestinationTag = function (tag, callback) {
	var self = this;
	this.db.get_user({dtag: tag}, function (user) {
		if (user && user.name) {
			var accountName = user.name;
			// to double check the tag matching account id. 
			self.steem.getAccounts([accountName], function (err, res) {
				if (!res || !res[0]) return callback('Steem Account Not Found');
				if (res[0].id == tag) {
					return callback(null, accountName);	
				};
				return callback('Steem Account Not Found');
			});
		} else {
			return callback('Steem Account Not Found');
		}
	})
}

Gateway.prototype.validateWithdrawalAccount = function (tx, callback) {
	if (typeof callback !== 'function') callback = function (){};
	var self = this;

	// first priority for using dtag.
	var tag = tx.tx_json.DestinationTag;
	if (tag) {
		self.validateDestinationTag(tag, function (err, accountName) {
			if (err) return callback('DestinationTag Error');
			if (accountName) return callback(null, accountName);
		});
	} else if (tx.tx_json && tx.tx_json.Memos && tx.tx_json.Memos[0] && tx.tx_json.Memos[0].Memo.MemoData) {
		var data = RippleUtils.hexToString(tx.tx_json.Memos[0].Memo.MemoData);
		if (!data) return callback('Steem Account Not Found');
		self.steem.getAccounts([data], function (err, res) {
			if (!res || !res[0]) return callback('Steem Account Not Found');
			var id = res[0].id;
			self.db.add_user({name: data, dtag: id});
			callback(null, data);
		});
	} else {
		callback('Steem Account Not Found');
	}
}

Gateway.prototype.createWithdrawal = function (tx, recipient) {
	var id = this.withdrawals.add(tx);
	if (!id) return;

	console.log('--- new withdrawal ---', tx.ledger_index)
	var stx = this.steem.transaction();

	var memo = JSON.stringify({
		type: "withdrawal",
		tx_id: tx.tx_json.hash,
		id: id, 
	})

	var amount = tx.metadata.delivered_amount;
	var withdrawal_fee = 0.001;
	if (amount.currency == Config.currency_stm) withdrawal_fee = Config.fee_stm;
	if (amount.currency == Config.currency_sbd) withdrawal_fee = Config.fee_sbd;
	
	var AMOUNT = {
		value: String(Math.floor(Number(amount.value) * 1000) / 1000 - withdrawal_fee),
		currency: amount.currency
	}
	var opts = {
	    from: Config.acc_steem,
	    to: recipient,
	    amount: this.toSteemAmount(AMOUNT),
	    memo: memo
	}
	stx.add_operation("transfer", opts);

	var timestamp = RippleUtils.toTimestamp(tx.tx_json.date);

	var self = this;
	this.getReferenceBlockForRippleTx(tx, function (err, res) {
		var block = res;
		if (!block) {
			console.log('Error: No Reference Block');
			return;	
		} 

		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;

		stx.complete();
		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');

		var msg = {
			type: 'withdrawal',
			id: id,
			sig: sig_hex,
		}

		self.withdrawals.addTransaction(id, stx);
		self.sendMessage(msg);
	});
}

// re-submitting a Steem transaction if it's expired. 
// expiration could happen when RCL servers fee is kept high for > 1hour, halting messages between signers.
Gateway.prototype.resubmitWithdrawal = function (id) {
	var wdr = this.withdrawals.get(id);
	if (!wdr || !wdr.tx) return;

	console.log('--- resubmit withdrawal ---', id)

	var self = this;

	function gotRefBlock (err, res) {
		if (!res) return;

		var block = res;
		var stx = wdr.stx;
		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;
		stx.complete();

		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');
		var msg = {
			type: 'withdrawal',
			id: wdr.id,
			sig: sig_hex,
		}
		self.sendMessage(msg);
		wdr.state = 'pending';
	}

	var tx = wdr.tx;
	if (typeof tx == 'number') {
		// signer-set-steem
		this.getReferenceBlockByLedgerNum(tx, gotRefBlock);
	} else if (tx.tx_json) {
		// withdrawal
		this.getReferenceBlockForRippleTx(tx, gotRefBlock);
	} else if (tx.block) {
		// bounced-deposit
		this.getReferenceBlockByNum(tx.block, gotRefBlock);
	}
}

Gateway.prototype.isOwnAccount = function (address) {
  if (address == Config.issuer) return true;
  return false;
}

// listening to withdrawals on RCL, start from minLedger.
Gateway.prototype.listenWithdrawal = function (minLedger) {
	var self = this;
	var account = this.ripple.account(Config.acc_ripple);
	account._listener.on('payment-in', function (tx){
		if (! tx.validated) return;
		if (tx.engine_result != 'tesSUCCESS') return;
		if (self.isOwnAccount(tx.Account)) return;

		if (! self.validateRippleAmount(tx)) {
			//ignore transaction				
			return;
		} else {
			self.validateWithdrawalAccount(tx, function (err, res) {
				if (err) return self.bounceWithdrawalQueue(tx, 'Invalid Recipient');
				if (res) self.createWithdrawal(tx, res);
			})
		}
	});

	if (minLedger) {
		account._listener._minLedger = minLedger;
		account._listener._handleReconnect();
	}	
}

// listening to deposit on Steem;
Gateway.prototype.listenDeposit = function (id) {
	var self = this;
	var acc = this.steem.addAccount(Config.acc_steem);

	function handleDeposit (trx) {
		var operation = trx.op[1];
		var memo = operation.memo.trim();
		if (operation.from == operation.to) {
			// virtual txns
			var data;
			try {
				data = JSON.parse(memo);
			} catch (e) {}
			if (typeof data !== 'object') return;

			if (data.type === 'bounced-withdrawal') {
				self.bounceWithdrawal(data, trx);
			} else if (data.type === 'account-set') {
				self.rippleAccountSet(data, trx);
			} else if (data.type === 'account-set-issuer') {
				self.rippleAccountSet(data, trx, true);
			} else if (data.type === 'trust-set-issuer') {
				self.trustSet(data, trx);
			}
		} else if (memo === Config.register_command) {
			self.handleRegister(trx);
		} else if (! self.validateDepositAmount(operation)) {
			// ignore txn.
			console.log('Invalid Deposit Amount.');
		} else if (! self.validateRecipient(memo)) {
			self.bounceDeposit(trx, 'Invalid Recipient');
		} else {
			self.createDeposit(trx);		
		}		
	}

	acc.on('transfer-in', handleDeposit);
	acc.subscribe();

	if (id) { // fetch historical txns.
		acc._marker = id;
		self.steem.getAccountHistory(acc._name, -1, 50, function (err, res) {
			if (err || !res) return;
			for (var i=0, l=res.length; i<l; i++) {
				var trx = res[i][1];
				var trx_id = Deposits.generateId(trx);
				if (trx_id <= id) continue;
				var type = trx.op[0];
				var data = trx.op[1];
				if (type === 'transfer' && data.to === acc._name) {
					handleDeposit(trx);
				}
			}
		})
	}

	var account = this.ripple.account(Config.acc_ripple);
	account._listener.on('memo-out', function (tx){
		var memo = tx.tx_json.Memos[0].Memo;
		var data = RippleUtils.hexToString(memo.MemoData);
		var type = RippleUtils.hexToString(memo.MemoType);
		var format = RippleUtils.hexToString(memo.MemoFormat);

		try {
			data = JSON.parse(data);
		} catch (e) {};

		if (typeof data == 'object' && data.id) {
			var seq = tx.tx_json.Sequence;
			var myTx = self.deposits.getTransaction(data.id);

			if (myTx && myTx.tx_json && (seq != myTx.tx_json.Sequence)) {
				throw 'Ripple Sequence Unmatched';				
			}

			self.deposits.setLastId(data.id);
		}
	})
}

// queue the bounce-withdrawal by making a memo on steem blockchain
// a workaround to get deterministic Sequence among deposits.
Gateway.prototype.bounceWithdrawalQueue = function (tx, message) {
	var id = this.withdrawals.add(tx, 'bounced-withdrawal-queue');

	if (!id) return;
	console.log('--- Bounced-Withdrawal Queue ---')

	var stx = this.steem.transaction();

	var memo = {
		type: 'bounced-withdrawal',
		tx_hash: tx.tx_json.hash,
		account: tx.tx_json.Account,
		amount: tx.metadata.delivered_amount,
		message: message,
		id: id
	}

	var opts = {
	    from: Config.acc_steem,
	    to: Config.acc_steem,
	    amount: "0.001 STEEM",
	    memo: JSON.stringify(memo)
	}
	stx.add_operation("transfer", opts);

	var self = this;
	this.getReferenceBlockForRippleTx(tx, function (err, res) {
		var block = res;
		if (!block) {
			console.log('Error: No Reference Block');
			return;	
		} 
		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;

		stx.complete();
		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');

		var msg = {
			type: 'virtual',
			id: id,
			sig: sig_hex,
		}

		self.withdrawals.addTransaction(id, stx);
		self.sendMessage(msg);
	});
}

Gateway.prototype.bounceWithdrawal = function (data, operation) {
	console.log('--- Withdrawal Bounced. Reason:', data.message, '---');

	var id = this.deposits.add(operation, 'bounced-withdrawal');
	if (!id) return;

	var seq = this.next_seq++;

	var RECIPIENT = data.account;
	var AMOUNT = data.amount;

	var bounce_fee = 0.001;
	if (AMOUNT.currency == Config.currency_stm) bounce_fee = Config.fee_stm;
	if (AMOUNT.currency == Config.currency_sbd) bounce_fee = Config.fee_sbd;
	AMOUNT.value = String(Number(AMOUNT.value) - bounce_fee);

	var transaction = this.ripple.transaction();

	transaction.tx_json.TransactionType = 'Payment';
	transaction.tx_json.Account = Config.acc_ripple;
	transaction.tx_json.Destination = RECIPIENT;
    transaction.tx_json.Sequence = seq;
    transaction.tx_json.DestinationTag = 0;
	transaction.tx_json.Fee = Config.fee * (this.signerList.quorum + 1);
	transaction.tx_json.SigningPubKey = '';

	transaction.tx_json.Amount = AMOUNT;

    var memotype = MEMOTYPE;
    var memoformat = MEMOFORMAT;
	var memodata = JSON.stringify({
	  type: 'bounced-withdrawal',
	  tx_id: data.tx_hash,
	  message: data.message,
	  id: id
	});

	transaction.tx_json.Memos = [ {
	      Memo : {
	                MemoType : RippleUtils.stringToHex(memotype),
	                MemoFormat: RippleUtils.stringToHex(memoformat),
	                MemoData : RippleUtils.stringToHex(memodata)
	             }
	} ];  

    transaction.tx_json.Flags = 0x80000000;
	transaction._multisign = true;
	transaction._multiSign = true;
	transaction._signerNum = this.signerList.quorum;

	transaction._complete = true;		//skip auto-fill process
	transaction._setFixedFee = true;	//avoid fee adjust
	transaction._setLastLedger = true;	//skip auto-fill lastledger

	var signer = transaction.getSignatureFor(Config.signer);

	this.deposits.addTransaction(id, transaction)

	var msg = {
		type: 'bounced-withdrawal',
		id: id,
		sig: signer,
	}

	this.sendMessage(msg);
}


Gateway.prototype.rippleAccountSet = function (data, operation, acc_issuer) {
	var pendings = acc_issuer ? 'issuer_txns' : 'deposits';
	var id = this[pendings].add(operation, 'account-set');
	if (!id) return;

	console.log('=== Ripple AccountSet ===');
	var seq = acc_issuer ? this.issuer_next_seq++ : this.next_seq++;

	var transaction = this.ripple.transaction();

	transaction.tx_json.TransactionType = 'AccountSet';
	transaction.tx_json.Account = acc_issuer ? Config.issuer : Config.acc_ripple;
    transaction.tx_json.Sequence = seq;
	transaction.tx_json.Fee = Config.fee * (this.signerList.quorum + 1);
	transaction.tx_json.SigningPubKey = '';

	var fields = ['Domain', 'EmailHash', 'MessageKey', 'TransferRate', 'SetFlag', 'ClearFlag']
	fields.forEach(function (field) {
		if (data.hasOwnProperty(field)) {
			transaction.tx_json[field] = data[field];
		}
	})

    var memotype = MEMOTYPE;
    var memoformat = MEMOFORMAT;
	var memodata = JSON.stringify({
	  id: id
	});

	transaction.tx_json.Memos = [ {
	      Memo : {
	                MemoType : RippleUtils.stringToHex(memotype),
	                MemoFormat: RippleUtils.stringToHex(memoformat),
	                MemoData : RippleUtils.stringToHex(memodata)
	             }
	} ];  

    transaction.tx_json.Flags = 0x80000000;
	transaction._multisign = true;
	transaction._multiSign = true;
	transaction._signerNum = this.signerList.quorum;

	transaction._complete = true;		//skip auto-fill process
	transaction._setFixedFee = true;	//avoid fee adjust
	transaction._setLastLedger = true;	//skip auto-fill lastledger

	var signer = transaction.getSignatureFor(Config.signer);

	this[pendings].addTransaction(id, transaction)

	var msg = {
		type: acc_issuer ? 'account-set-issuer' : 'account-set',
		id: id,
		sig: signer,
	}

	this.sendMessage(msg);
}

// allow user to register a dtag, in case the database not up-to-date.
Gateway.prototype.handleRegister = function (trx) {
	var self = this;
	var operation = trx.op[1];
	var memo = operation.memo.trim();
	var from = operation.from;
	if (memo !== Config.register_command) return;

	// minimum 0.2 for registration
	var amount = this.parseSteemAmount(operation.amount);
	if (Number(amount.value) < 0.002) return;

	self.steem.getAccounts([from], function (err, res) {
		if (!res || !res[0] || !res[0].id) return;
		var id = res[0].id;
		self.db.add_user({name: from, dtag: id}, function(){
			console.log('register user:', from, id);
			self.replyRegistration(trx, id);
		});
	});
}

Gateway.prototype.replyRegistration = function (trx, dtag) {
	console.log('--- Replying Registration ---')

	var id = this.withdrawals.add(trx, 'register-reply');
	if (!id) return;

	var op = trx.op[1];
	var amount = this.parseSteemAmount(op.amount);
	amount.value = String(0.001);

	var memo = JSON.stringify({
		type: "register",
		dtag: dtag,
		id: id, 
	})

	var stx = this.steem.transaction();
	var opts = {
	    from: Config.acc_steem,
	    to: op.from,
	    amount: this.toSteemAmount(amount),
	    memo: memo
	}
	stx.add_operation("transfer", opts);

	var timestamp = new Date(trx.timestamp).getTime();

	var self = this;
	this.getReferenceBlockByNum (trx.block, function (err, block) {
		if (!block) {
			console.log('Error: No Reference Block');
			return;	
		} 

		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;

		stx.complete();
		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');

		var msg = {
			type: 'withdrawal',
			id: id,
			sig: sig_hex,
		}
		self.withdrawals.addTransaction(id, stx);
		self.sendMessage(msg);
	})
}


Gateway.prototype.bounceDeposit = function (trx, message) {
	console.log('--- Deposit Bounced. Reason:', message, '---')

	var id = this.withdrawals.add(trx, 'bounced-deposit');
	if (!id) return;

	var op = trx.op[1];
	var amount = this.parseSteemAmount(op.amount);
	var bounce_fee = 0.001;
	if (amount.currency == Config.currency_stm) bounce_fee = Config.fee_stm;
	if (amount.currency == Config.currency_sbd) bounce_fee = Config.fee_sbd;
	amount.value = String(Number(amount.value) - bounce_fee);

	var memo = JSON.stringify({
		type: "bounced-deposit",
		tx_id: trx.trx_id, 
		id: id,
		message: message
	})
	
	var stx = this.steem.transaction();
	var opts = {
	    from: Config.acc_steem,
	    to: op.from,
	    amount: this.toSteemAmount(amount),
	    memo: memo
	}
	stx.add_operation("transfer", opts);

	var timestamp = new Date(trx.timestamp).getTime();

	var self = this;
	this.getReferenceBlockByNum(trx.block, function (err, block){
		if (!block) {
			console.log('Error: No Reference Block');
			return;	
		} 

		stx.ref_block_num = (self.steem.parseBlockNum(block.previous)) & 0xFFFF;
		stx.ref_block_prefix = new Buffer(block.previous, 'hex').readUInt32LE(4);
		stx.expiration = block.timestamp_sec + 3600;

		stx.complete();
		var sig_hex = stx.getSignatureFor(Config.signer).toString('hex');

		var msg = {
			type: 'withdrawal',
			id: id,
			sig: sig_hex,
		}
		self.withdrawals.addTransaction(id, stx);
		self.sendMessage(msg);		
	})
}

Gateway.prototype.isSigner = function (accountId) {
	for (var account in this.signerList.signers) {
		if (accountId === account) return true;
	}
	return false;
}

// listening to Messages broadcasted by delegates.
Gateway.prototype.listenMessage = function (minLedger) {
	var self = this;
	var account = this.ripple.account(Config.acc_msg);

	function handleMessage (msg, from, marker) {
		console.log('msg from:', 'r...' + from.slice(-5), + self.isSigner(from));
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			console.log('error parsing msg.')
		}
		if (typeof msg != 'object') return;
		if (!msg.id || !msg.sig || !msg.type) return;

		var type = msg.type;
		var id = msg.id;

		if (type == 'deposit' || type == 'bounced-withdrawal') {
			self.deposits.addSignature(from, id, msg.sig, marker);
			if (self.deposits.hasQuorum(id)) {
				var trx = self.deposits.get(id).trx;
				self.deposits.submitTransaction(id, function (err, res) {
					if (err) {
						if (err.engine_result && err.engine_result.slice(0,3) == 'tec') {
							if (type == 'bounced-withdrawal') {
								return console.log('=== bounced-withdrawal Failed', err.engine_result, '===');
							}
							self.bounceDeposit(trx, err.engine_result);							
						} else console.log(err.engine_result);
					} 
				});
			}
		}

		if (type == 'withdrawal' || type == 'bounced-deposit' || type == 'signer-set-steem' || type == 'virtual') {
			self.withdrawals.addSignature(from, id, msg.sig, marker);
			if (self.withdrawals.hasQuorum(id)) {		
				self.withdrawals.submitTransaction(id, function (err, res) {
					if (err && err.expired) {
						console.log(err);
						self.resubmitWithdrawal(id);
					}
				});
			}
		}

		if (type == 'signer-set-ripple' || type == 'account-set') {
			self.deposits.addSignature(from, id, msg.sig, marker);
			if (self.deposits.hasQuorum(id)) {
				var sl = self.deposits.get(id).signerList;		
				self.deposits.submitTransaction(id, function (err, res) {
					if (err) {
						console.log('===', type, id, err.engine_result, '===');
					} else if (res) {
						console.log('===', type, id, 'Done ===');
						if (sl && res.tx_json && res.tx_json.SignerEntries) {
							self.signerList = sl;
							fs.writeFile('signers.txt', JSON.stringify(sl, null, "  "))

							// resubmit txns that's might had failed during transition period.
							self.deposits.resubmit();
							self.withdrawals.resubmit();							
						}
					}
				});
			}
		}

		if (type == 'signer-set-issuer' || type == 'account-set-issuer' || type == 'trust-set-issuer') {
			self.issuer_txns.addSignature(from, id, msg.sig, marker);
			if (self.issuer_txns.hasQuorum(id)) {
				var sl = self.issuer_txns.get(id).signerList;		
				self.issuer_txns.submitTransaction(id, function (err, res) {
					if (err) return console.log('===', type, id, err.engine_result, '===');
					else console.log('===', type, id, 'Done ===');
				});
			}	
		}
	}

	account._listener.on('memo-in', function (transaction){
		var from = transaction.tx_json.Account;
		var memos = transaction.tx_json.Memos;
		if (! Array.isArray(memos)) return;

		function toHex (num) { return h = ("00000000" + num.toString(16)).substr(-8); }
		var marker = toHex(transaction.ledger_index) + toHex(transaction.metadata.TransactionIndex);
		
		memos.forEach(function (memo) {
			var type = memo.Memo.MemoType ? RippleUtils.hexToString(memo.Memo.MemoType) : undefined;
			var data = memo.Memo.MemoData ? RippleUtils.hexToString(memo.Memo.MemoData) : undefined;
			var format = memo.Memo.MemoFormat ? RippleUtils.hexToString(memo.Memo.MemoFormat) : undefined;

			if (data && type == MEMOTYPE_MSG) handleMessage (data, from, marker);
		});
	});

	// fetch recent txns.
	if (minLedger) {
		account._listener._minLedger = minLedger;
		account._listener._handleReconnect();
	}
}

Gateway.prototype.createDeposit = function (trx) {	
	var id = this.deposits.add(trx);
	if (!id) return;

	var op = trx.op[1];
	console.log('--- new deposit ---', trx.block)

	var seq = this.next_seq++;

	var dest = op.memo.trim().split(/\W+/);
	var RECIPIENT = dest[0];
	var DTAG = Number(dest[1]);

	var AMOUNT = this.parseSteemAmount(op.amount);
	AMOUNT.issuer = Config.issuer;

	var deposit_fee = 0.001;
	if (AMOUNT.currency == Config.currency_stm) deposit_fee = Config.fee_stm;
	if (AMOUNT.currency == Config.currency_sbd) deposit_fee = Config.fee_sbd;
	AMOUNT.value = String(Number(AMOUNT.value) - deposit_fee);

	var transaction = this.ripple.transaction();
	
	transaction.tx_json.TransactionType = 'Payment';
	transaction.tx_json.Account = Config.acc_ripple;
	transaction.tx_json.Destination = RECIPIENT;
	transaction.tx_json.Amount = AMOUNT;
	transaction.tx_json.Sequence = seq;
	if (DTAG) transaction.tx_json.DestinationTag = DTAG;
	transaction.tx_json.Fee = Config.fee * (this.signerList.quorum + 1);
	transaction.tx_json.SigningPubKey = '';;

    var memotype = MEMOTYPE;
    var memoformat = MEMOFORMAT;
	var memodata = {
	  type: 'deposit',		
	  from: op.from,
	  tx_id: trx.trx_id,
	  id: id,	
	}
    var memodata = JSON.stringify(memodata);

	transaction.tx_json.Memos = [ {
	      Memo : {
	                MemoType : RippleUtils.stringToHex(memotype),
	                MemoFormat: RippleUtils.stringToHex(memoformat),
	                MemoData : RippleUtils.stringToHex(memodata)
	             }
	} ];  

    transaction.tx_json.Flags = 0x80000000;
	transaction._multisign = true;
	transaction._multiSign = true;
	transaction._signerNum = this.signerList.quorum;

	transaction._complete = true;		//skip auto-fill process
	transaction._setFixedFee = true;	//avoid fee adjust
	transaction._setLastLedger = true;	//skip auto-fill lastledger

	var signer = transaction.getSignatureFor(Config.signer);

	this.deposits.addTransaction(id, transaction)

	var msg = {
		type: 'deposit',
		id: id,
		sig: signer,
	}

	this.sendMessage(msg);
}

// broadcast a msg
Gateway.prototype.sendMessage = function (msg) {
	var self = this;

	var transaction = this.ripple.transaction();
	transaction.tx_json.TransactionType = 'Payment';
	transaction.tx_json.Account = Config.signer;
	transaction.tx_json.Destination = Config.acc_msg;
	transaction.tx_json.DestinationTag = 0;
	transaction.tx_json.Amount = '1';
	transaction.tx_json.Fee = Config.fee;

	if (typeof msg == 'object') msg = JSON.stringify(msg);
	var memotype = MEMOTYPE_MSG;    
    var memoformat = MEMOFORMAT_MSG;
    var memodata = msg;	
	transaction.tx_json.Memos = [ {
	      Memo : {
	                MemoType : RippleUtils.stringToHex(memotype),
	                MemoFormat: RippleUtils.stringToHex(memoformat),
	                MemoData : RippleUtils.stringToHex(memodata)
	             }
	} ];

	transaction._setLastLedger = true;
	transaction._setFixedFee = true;

	transaction.once('submitted', function(res) {
		console.log(transaction.tx_json.Sequence, res.result, transaction.submitIndex)
	})
	transaction.on('resubmitted', function(res) {
		console.log(transaction.tx_json.Sequence, 'resubmitted', transaction.attempts, res.result)
		// somehow the telINSUF_FEE_P of a server wont go away without reconnect.
		if (res.result === 'telINSUF_FEE_P') {
			self.ripple.reconnect();
		}
	})

	transaction.submit(function (err, res){
		if (err) throw err;
	});
}


// fetch info of new accounts from blockchain into db.
// since majority of new-accounts are created by @steem, we first check from txn-history of @steem, 
// then only stream part of blockchain to find others.
Gateway.prototype.update_db = function (default_limit) {
	if (this.db.read_only) return;
	if (!default_limit) default_limit = 10;
	var self = this;

	function update (opts) {
		var previous = opts.last_id;
		var previous_trx = opts.trx;
		var previous_block = opts.block;
		if (typeof previous != 'number') return;
		if (typeof previous_block != 'number') return;

		var limit = opts.limit || default_limit;
		self.steem.getAccountHistoryWith({
			account: 'steem',
			from: -1,
			limit: limit,
		}, function (err, res) {
			if (err) return;
			if (!res.length) return;
			if (res[0][0] > previous_trx) {
				opts.limit = limit + (res[0][0] - previous_trx);
				return update(opts);
			}

			function next (i) {
				if (i >= res.length) return console.log('=== Done db_update ===');
				var op = res[i][1].op;
				var trx_num = res[i][0];
				var blocknum = res[i][1].block;
				if (op[0] == 'account_create_with_delegation'){
					var acc = op[1]['new_account_name'];
					self.steem.getAccounts([acc], function (e, r){
						var id = r[0].id;
						if (id <= previous) {
							// skip
							next(i+1);
						} else if (id == previous + 1) {
							self.db.add_user({ name: acc, id: id }, done);
						} else if (id > previous + 1){
							// a gap, scan all blocks in-between for new accounts not created by @steem.
							var opts = {
								min: previous_block,
								max: blocknum,
							}
							scan(opts, done)
						}

						function done () {
							// update the counter.
							previous = id;
							previous_block = blocknum;
							self.db.set_counter({
								last_id: id,
								trx: trx_num,
								block: blocknum,
	 						});
							next(i+1);								
						}
					})
				} else {
					next(i+1);	
				}
			}
			next(0);
		})
	}

	function scan (opts, callback) {
		if (typeof callback !== 'function') callback = function () {};
		if (!opts || !opts.min || !opts.max) return;

		var blockNum = opts.min;
		function next () {
			if (blockNum > opts.max) return callback();
			self.steem.getBlockWith({
				blockNum: blockNum,
				broadcast:  function (res, server) { return (res && res.previous) }
			}, function (err, block) {
				var num = self.steem.getBlockNum(block);
				block['transactions'].forEach(function(tx){
					tx.operations.forEach(function(op){
						if (op[0] == 'account_create_with_delegation') {
							var acc = op[1].new_account_name;
							self.steem.getAccounts([acc], function (e, r){
								var id = r[0].id;
								self.db.add_user({ name: acc, id: id }, function (){
									self.db.get_counter(function (c) {
										if (id < c.last_id || num <= c.block) return;
										self.db.set_counter({
											last_id: id,
											block: num,
				 						});
									})
								});
							})
						}
					})
				})
				blockNum++;
				next()
			})
		}
		next();
	}

	console.log('=== start db_update ===');
	this.db.get_counter(function (data) {
		if (data) update(data);
	})
}


module.exports = Gateway;

return;