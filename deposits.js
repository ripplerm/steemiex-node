var Config = require('./config');
var Utils = require('steem-lib').Utils;

// ========================================================================

function Deposits (gateway) {
	this._gateway = gateway;
	this._queue = new Map();
	this._sigs = {};
	this._last_id_steem = '000000000000000000000000';
	this._last_id_ripple = '0000000000000000';
}

Deposits.generateId = 
Deposits.prototype.generateId = function (tx) {
	function toHex (num) {
		return h = ("00000000" + num.toString(16)).substr(-8);
	}

	if (tx.op) return [tx.block, tx.trx_in_block, tx.op_in_trx].map(toHex).join('');
	if (tx.ledger_index) return toHex(tx.ledger_index) + toHex(tx.metadata.TransactionIndex);
}

Deposits.prototype.hasFinalized = function (id) {
	if (id.length === this._last_id_steem.length && id <= this._last_id_steem) return true;
	if (id.length === this._last_id_ripple.length && id <= this._last_id_ripple) return true;
	return false;
}

Deposits.prototype.setLastId = function (id) {
	if (id.length === this._last_id_steem.length && id > this._last_id_steem) {
		this._last_id_steem = id;
	}
	if (id.length === this._last_id_ripple.length && id > this._last_id_ripple) {
		this._last_id_ripple = id;
	}
}

Deposits.prototype.has = function (id) {
	if (this.get(id)) return true;
	if (this.hasFinalized(id)) return true;
	return false;
}

Deposits.prototype.add = function (trx, type) {
	var id = this.generateId(trx);
	if (this.has(id)) return false; //duplicate txn

	var dep = {
		id: id,
		trx: trx,
		state: 'pending',
		type: type || 'deposit',
	}
	this._queue.set(id, dep);

	return id;
}

Deposits.prototype.get = function (id) {
	return this._queue.get(id);
}

Deposits.prototype.finalize = function (id, result) {
	var dep = this.get(id);
	if (!dep || dep.finalized) return;

	this.setLastId(id);
	dep.finalized = true;
	dep.state = 'finalized';

	if (dep.transaction && !dep.transaction.finalized) dep.transaction.finalize(result);

	//save result & sigs to Database
	this._gateway.db.save_tx({
		id: id,
		type: dep.type,
		result_tx: (result && result.tx_json) ? result.tx_json.hash : '',
		source_tx: dep.trx ? (dep.trx.tx_json ? dep.trx.tx_json.hash : dep.trx.trx_id) : '',
		sigs: this._sigs[id],
	});

	this.remove(id);
	this.removeSignature(id);
	console.log('finalized', id);
}

Deposits.prototype.remove = function (id) {
	this._queue.delete(id);
}

Deposits.prototype.removeSignature = function (id) {
	for (var sid in this._sigs) {
		if (sid == id) delete this._sigs[sid];
	}
}

Deposits.prototype.addSignature = function (from, id, sig, marker) {
	if (!this._sigs[id]) this._sigs[id] = {};

	if (typeof sig == 'string') {
		try {
			sig = JSON.parse(sig)
		} catch (e) {}		
	}
	if (typeof sig !== 'object') return;
	if (!sig.Signer || !sig.Signer.Account || !sig.Signer.SigningPubKey || !sig.Signer.TxnSignature) return;

	this._sigs[id][from] = {signature: sig, marker: marker};
}

Deposits.prototype.hasQuorum = function (id) {
	var sigs = this._sigs[id];
	var tx = this.getTransaction(id);
	if (!sigs || !tx) return false;

	var q = 0;
	for (var account in sigs) {
		var signer = this._gateway.signerList.signers[account];
		if (!signer) continue;

		try {
			sigs[account].valid = Utils.verifySignature({
							hash: tx.multiSigningHash(account), 
							pubkey: sigs[account].signature.Signer.SigningPubKey,
							signature: sigs[account].signature.Signer.TxnSignature,
						});			
		} catch (e) {
			sigs[account].valid = false;
		};
		if (! sigs[account].valid) continue;

		q += signer.weight || 0;
	}

	console.log('votes', id, q)
	if (q >= this._gateway.signerList.quorum) return true;
	
	return false;
}

Deposits.prototype.getSignatures = function (id) {
	var sigs = [];
	for (var account in this._sigs[id]) {
		if (this._gateway.isSigner(account) && this._sigs[id][account].valid) {
			sigs.push(this._sigs[id][account].signature);
		}
	}
	if (sigs.length > this._gateway.signerList.quorum) {
		sigs.sort(function(a,b){return a.marker - b.marker});
		sigs = sigs.slice(0, this._gateway.signerList.quorum);
	}
	return sigs;
}

Deposits.prototype.submitTransaction = function (id, callback) {
	if (typeof callback != 'function') callback = function (){};
	var self = this;

	var dep = this.get(id);
	if (!dep || dep.state != 'pending') return;

	var tx = dep.transaction;
	if (!tx) return;

	tx.tx_json.Signers = [];
	this.getSignatures(id).forEach(function (signature) {
		tx.addSignature(signature);
	});
	if (tx.tx_json.Signers.length < this._gateway.signerList.quorum) return;

	tx._multiSignComplete = true;

	function handleResponse(err, res){
		if (err) {
			if (err && err.result && err.result.slice(0,3) == 'tej') {
				throw err.result
			}
			if (err.engine_result && err.engine_result.slice(0,3) == 'tec') {
				self.finalize(id, err);
			}
			callback(err);
			return;
		}
		if (res && res.tx_json) {
			self.finalize(id, res);
			callback(err, res)
		}
	}

	tx.once('submitted', function (message) {
		var result = message.result;
		console.log('Rippled response:', result)
	})

	tx.on('resubmitted', function(res) {
		console.log(tx.tx_json.Sequence, 'resubmitted', tx.attempts, res.result)
		if (res.result === 'telINSUF_FEE_P') {
			self._gateway.ripple.reconnect();
		}
		if (res.result === 'tefPAST_SEQ') {
			tx.remote.requestTransaction({hash: res.tx_json.hash}, function (err, res){
				if (!res || !res.validated) return;
				var transaction = {
					tx: res,
					meta: res.meta,
					validated: res.validated
				}
				tx.getManager()._transactionReceived(transaction);
			})		
		}		
	})

	console.log('submitting Ripple tx.....')
	dep.state = 'submitting';
	tx.submit(handleResponse);
}

Deposits.prototype.addTransaction = function (id, tx) {
	var dep = this.get(id);
	if (dep) dep.transaction = tx;
}

Deposits.prototype.getTransaction = function (id) {
	var dep = this.get(id);
	return dep ? dep.transaction : null;
}

Deposits.prototype.resubmit = function () {
	var self = this;
	this._queue.forEach(function (p, id){
		p.state = 'pending';
		if (self.hasQuorum(id)) self.submitTransaction(id);
	})
}

module.exports = Deposits;