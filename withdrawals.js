var Config = require('./config');
var Utils = require('steem-lib').Utils;
var PublicKey = require('steem-lib').PublicKey;

// ========================================
function Withdrawals (gateway) {
	this._gateway = gateway;
	this._queue = new Map();
	this._sigs = {};
	this._last_id_steem = '000000000000000000000000';
	this._last_id_ripple = '0000000000000000';
}

Withdrawals.prototype.generateId = function (tx) {
	function toHex (num) {
		return h = ("00000000" + num.toString(16)).substr(-8);
	}

	if (tx.op) return [tx.block, tx.trx_in_block, tx.op_in_trx].map(toHex).join('');
	if (tx.ledger_index) return toHex(tx.ledger_index) + toHex(tx.metadata.TransactionIndex);
	if (typeof tx == 'number') return tx;
}

Withdrawals.prototype.hasFinalized = function (id) {
	if (id.length === this._last_id_steem.length && id <= this._last_id_steem) return true;
	if (id.length === this._last_id_ripple.length && id <= this._last_id_ripple) return true;
	return false;
}

Withdrawals.prototype.setLastId = function (id) {
	if (id.length === this._last_id_steem.length && id > this._last_id_steem) {
		this._last_id_steem = id;
	}
	if (id.length === this._last_id_ripple.length && id > this._last_id_ripple) {
		this._last_id_ripple = id;
	}
}

Withdrawals.prototype.has = function (id) {
	if (this.get(id)) return true;
	if (this.hasFinalized(id)) return true;
	return false;
}

Withdrawals.prototype.add = function (tx, type) {
	var id = this.generateId(tx)
	if (this.has(id)) return false; //duplicate txn

	var wdr = {
		id: id,
		tx: tx,
		state: 'pending',
		type: type || 'withdrawal'
	}

	this._queue.set(id, wdr);

	return id;	
}

Withdrawals.prototype.get = function (id) {
	return this._queue.get(id);
}

Withdrawals.prototype.finalize = function (id, tx_id, tx) {
	var wdr = this.get(id);
	if (!wdr) return;

	this.setLastId(id);
	wdr.finalized = true;
	wdr.state = 'finalized'

	//save result & sigs to Database
	this._gateway.db.save_tx({
		id: id,
		type: wdr.type,
		result_tx: tx_id,
		source_tx: wdr.tx ? (wdr.tx.tx_json ? wdr.tx.tx_json.hash : wdr.tx.trx_id) : '',
		sigs: this._sigs[id],
	});

	this.remove(id);
	this.removeSignature(id);
	console.log('finalized', id);
}

Withdrawals.prototype.remove = function (id) {
	this._queue.delete(id);
}

Withdrawals.prototype.removeSignature = function (id) {
	for (var sid in this._sigs) {
		if (sid == id) delete this._sigs[sid];
	}
}

Withdrawals.prototype.addSignature = function (from, id, sig, marker) {
	if (!this._sigs[id]) this._sigs[id] = {};
	this._sigs[id][from] = {signature: sig, marker: marker};
}

Withdrawals.prototype.hasQuorum = function (id) {
	var sigs = this._sigs[id];
	var tx = this.getTransaction(id);
	if (!sigs || !tx) return false;

	var q = 0;
	for (var account in sigs) {
		var signer = this._gateway.signerList.signers[account];
		if (!signer) continue;

		try {
			sigs[account].valid = Utils.verifySteemSignature({
									tr_buf: tx.toBuffer(), 
									pubkey: PublicKey.fromHex(this._gateway.signerList.signers[account].pubkey),
									signature: sigs[account].signature,
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

Withdrawals.prototype.getSignatures = function (id) {
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

Withdrawals.prototype.submitTransaction = function (id, callback) {
	var self = this;
	var wdr = this.get(id);
	if (!wdr || wdr.state != 'pending') return;

	var stx = wdr.stx;
	if (!stx) return;

	stx.signatures = [];
	this.getSignatures(id).forEach(function (signature) {
		stx.addSignature(signature);
	});
	if (stx.signatures.length < this._gateway.signerList.quorum) return;

	stx.once('success', function(msg){
		self.finalize(id, stx.transaction_id, msg);
	})

	stx.on('submitted', function(msg){
		wdr.state = 'submitted';
		if (msg.block || msg.block_num) console.log('submitted.', msg.block_num, (typeof msg.trx_num != 'undefined') ? msg.trx_num : msg.transaction_num);
	});

	console.log('submitting Steem tx', stx.transaction_id);
	wdr.state = 'submitting';
	stx.submit(callback);
}

Withdrawals.prototype.addTransaction = function (id, tx) {
	var wdr = this.get(id);
	if (wdr) wdr.stx = tx;
}

Withdrawals.prototype.getTransaction = function (id) {
	return this.get(id) ? this.get(id).stx :  null;
}

Withdrawals.prototype.resubmit = function () {
	var self = this;
	this._queue.forEach(function (p, id){
		p.state = 'pending';
		if (self.hasQuorum(id)) self.submitTransaction(id);
	})
}

module.exports = Withdrawals;