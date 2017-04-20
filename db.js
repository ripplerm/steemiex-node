var monk = require('monk');

//======================================
var READ_ONLY = false;
var SAVE_TXNS = true;

var USERS_COLLECTION = 'users';
var TXNS_COLLECTION = 'transactions';
// =====================================

function db (url) {
	var self = this;
	this.url = url;
	this.db = monk(url);
	this.read_only = READ_ONLY;
}

db.prototype._refresh = function () {
	console.log('reset mongodb...')
	this.db = monk(this.url);
}

db.prototype.add_user = function (opts, callback) {
	if (typeof callback !== 'function') callback = function () {};
	if (READ_ONLY) return;

	if (!opts || !opts.name) return;
	var id = (typeof opts.id == 'number') ? opts.id : opts.dtag;
	if (typeof id != 'number') return;

	var query = { name: opts.name };
	var update = { '$set': {id: id} };
	var options = {	upsert: true };

	this.db.get(USERS_COLLECTION)
	.update(query, update, options)
	.then(function(res){
		callback();
	})
	.catch(function(err){
		self._refresh();
	});
}

db.prototype.get_user = function (opts, callback) {
	if (typeof callback !== 'function') callback = function () {};
	if (!opts) return;
	var id = (typeof opts.id == 'number') ? opts.id : opts.dtag;

	var query = { id: id };
	this.db.get(USERS_COLLECTION)
	.findOne(query)
	.then(function(res){
		callback(res);
	})
	.catch(function(err){
		self._refresh();
	});
}

db.prototype.get_counter = function (callback) {
	if (typeof callback !== 'function') callback = function () {};
	this.db.get(USERS_COLLECTION)
	.findOne({counter: 'id'})
	.then(function(data){
		callback(data);
	});
}

db.prototype.set_counter = function (opts, callback) {
	if (typeof callback !== 'function') callback = function () {};
	if (typeof opts !== 'object') return;

	var query = { counter: 'id' };
	var update = { '$set': opts }
	var options = {	upsert: true };

	this.db.get(USERS_COLLECTION)
	.update(query, update, options)
	.then(function(res){
		callback();
	});
}

db.prototype.save_tx = function (tx, callback) {
	if (!SAVE_TXNS) return;
	if (typeof tx !== 'object') return;
	var self = this;

	var query = {
		id: tx.id,
		type: tx.type
	}

	this.db.get(TXNS_COLLECTION)
	.update(query, tx, {upsert: true})
	.then(function(res){})
	.catch(function(err){
		self._refresh();
	});
}


// ================================================
module.exports = db;