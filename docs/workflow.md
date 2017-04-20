## Overview

Each nodes will be continously watching RCL & Steem blockchain, listening for any incoming deposits/withdrawals, as well as the messages amongs validators/signers.

When there's a deposit/withdrawal, steemiex-node will verify and process the txn according to a set of fixed rules. Signatures for validating deposits/withdrawals will be broadcasted on RCL (via txn memo). Once the required number of signatures had been collected, transactions will be processed/broadcasted to the networks.

---
## Gateway's Operating Accounts
* on Steem network: `steemiex`
* on RCL network: 
  * Hotwallet: `r3dpA9FBczceWTWh4FRquuSvEVaQyU3GNg`
  * Issuing account: `rKYyUDK7N4Wd685xjfMeXM9G8xEe5ciVkC`

The gateway is using [Bank_Wallet_Construction](https://wiki.ripple.com/index.php?title=Hot_%26_cold_wallet_setup&oldid=9015#Bank_Wallet_Construction) for its hot-cold-wallet setting on RCL.

All operating accounts on both Steem and RCL are set to be M-of-N multi-signature, with quorum > 50% of validators number.

#### Messaging account:
Messages between validators are broadcasted publicly on RCL, by sending payments with memo to account `rwXZe6N3YMtKuGkZDjoqeS6KE3am3U7br`.

#### IOUs Symbol
The currency symbol used on RCL is `STM` and `USD`, representing STEEM and SBD on Steem blockchain.

---

## Deposit Method
Before making a deposit, a user must had set a sufficient trust-limit to gateway's issuing account `rKYyUDK7N4Wd685xjfMeXM9G8xEe5ciVkC` for the currency to be deposited.

To make a deposit, a user can send some amount of STEEM or SBD to account `steemiex` on Steem network, specifying a Ripple address in the memo field as recipient. An (optional) destination tag could be stated following the address, separated by a space/comma.

A deposit will be processed as soon as it's get into an *irreversible-block* on Steem blockchain (typically took about 1-minutes).

Any deposit that's doesn't meet a *minimum amount* requirement will be ignored completely. (Currently the minimum requirements are set as 1 STEEM and 1 SBD).

Any deposit without a valid Ripple address in its memo will be bounced.

#### Bounced-deposit
Each deposit is assigned a unique `Sequence` when submitted to RCL. Once it's fail (getting a `tec` error code on RCL), the gateway will bounce the deposit immediately by sending the same amount (less processing-fee) to the orginate account on Steem network.

## Withdrawal Method
To make a withdrawal, user can send STM or USD to the gateway's operating account (hotwallet) `r3dpA9FBczceWTWh4FRquuSvEVaQyU3GNg`, by specifying a Steem account in the `MemoData` field of its first Memo in the txn. 

Since most of the RCL clients for end-users currently doesn't support memo, we allow an alternative method -- users could send a payment with a `DestinationTag` that's equal to the Id of the targeted account on Steem blockchain.

If both Memo and DestinationTag were used in a txn, the DestinationTag will overwrite.   

Withdrawals that’s doesn’t meet a *minimum amount* requirement (1 STM or 1 USD) will be ignored.  
Withdrawals with invalid recipient account (or Id) will be bounced immediately.


#### bounced-withdrawal
Bounced withdrawal will only be submitted to RCL once. It's the user responsibility to make sure that his Ripple account has sufficient trust-limit for receiving the bounced amount.

---

## Transactions Construction
A protocol to ensure that all transactions for deposits/withdrawals could be constructed in a deterministic way.

#### Steem Transactions
`Amount`: must be equal the deposit/withdraw amount less a _processing-fee_. If a withdrawal amount from RCL has more than 3 decimals, it will be  rounding downwards.

`ref_block`: determined by the timestamp of the initiating txn. For a withdrawal, the ref_block to be used is the one with timestamp immediately before: [ (timestamp of withdrawal txn) - (two minutes) ].

For a bounced-deposit, the previous block of the deposit txn will be used. (e.g. if a deposit-txn was on block N, then block N-1 would be used for ref_block)

`expiration`: = timestamp of ref_block + 3600 sec.

`memo`: a JSON string with following fields:
* `type`: _"withdrawal", "bounced-deposit", etc..._
* `tx_id`: _the tx_id of the original withdrawal/deposit_
* `id`: _a unique label for the transaction_
  

#### Ripple Transactions
`Amount`: must be equal the deposit/withdrawal amount, less _processing fee_.

`Sequence`: Deposits are processed in the same order as they appeared on Steem blockchain. Hence the `Sequence` of a deposit is deterministicly assigned, and should not be altered.

For any transaction that's not triggered by a txn from Steem blockchain, _e.g. bounced-withdrawal_, a virtual deposit-txn will first be constructed and submitted to Steem network, so that the `Sequence` for the transaction could be determined from this virtual-txn.


`Fee`: = (quorum + 1) * 1000.

`Memos`: a Memo will be attached with the following format:
* MemoType: 'gateway'
* MemoFormat: 'text/json'
* MemoData: a JSON string containing some of these fields:
  * `type`: _"deposit", "bounced-withdrawal"_
  * `from`: (for deposits) _the originate account_
  * `tx_id`: _the tx_id of the original withdrawal/deposit_
  * `message`: (for bounced-withdrawals) _the error message_
  * `id`: _a unique label for the transaction_

#### Transactions Id
Each transaction is labeled with a unique `id`, which is generated with following rules:
* For RCL originated tx (eg. withdrawals), the `id` = (4-bytes ledger-index) + (4-bytes transaction-index) of the tx, represented in hex-string.
* For Steem originated tx (eg. deposits), the `id` = (4-bytes block-num) + (4-bytes transaction-num) + (4-byte operation-num) of the tx, represented in hex-string.
* For auto-update of gateway accounts (triggered by 'ledger-closed' event), `id` is a number representing the ledger-index.
 
This `id` is included in the memos of all transactions to be constructed. It's also used in the messages between validators for indentifying txns.

#### Processing Fee
There will be a fee for processing deposits/withdrawals.   
Currenty it's set at 0.001 STEEM, and 0.001 SBD.

---

## Messages Between Validators

Communication between nodes is done via sending memos to account:
`rwXZe6N3YMtKuGkZDjoqeS6KE3am3U7br` on RCL.

#### Format
Messages are constructed with the following settings:
* MemoType = 'msg';
* MemoFormat = '1.0.0';
* MemoData = a JSON string, containing the following fields:
  * `type` - 'deposit', 'withdrawal', etc.
  * `id` - a label identifying original txn.
  * `sig` - validator's signature for processing transaction. 
  


#### Misc

The default setting of steemiex-node is to use max_fee = 1000 drops for its ripple-client. This should be sufficient to keep the messaging and transaction-processing alive in most situation. A temporarily spike in RCL network fee would normally just cause some slight delay on deposit/withdrawal processing.

In rarer cases when RCL network-fee become exceptional high for prolonged period, human intervention might be needed to change the fee-setting.

---
## Configuration
Some of the above settings are stored in the Config object in `Config.js`. These configuration must not be altered before getting consensus among validators.
