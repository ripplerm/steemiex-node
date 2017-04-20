At interval of every 10k-ledger-closed (on RCL), steemiex-node might propose changes on gateways' account settings, depends on the content of several files:
* signers_proposed.txt
* accountset_proposed.txt
* trusts_proposed.txt


## Changes of signersList
`signers_proposed.txt` is used for proposing new list of validators. Steemiex-node will try to read the file and if the content is found to be different from existing signerList, the steemiex-node will broadcasting its signature for an "account_update" txn on Steem. When enough signatures were collected, the transaction will be broadcasted, then followed by "SignerListSet" transactions on RCL to update the new signerList into the Hotwallet and Issuing-account. 

Content of the file is a JSON object with:

__signers:__
an object containing validators as properties. 
Each signer is labeled with its Ripple address, and contain 2 fields:
* weight: should be 1 for every signer.
* pubkey: signing public-key of validator, in hex format.

The same signing keys will be used for all gateway's operating accounts, on both RCL and Steem blockchain. (ripple account of a signer/validator should be derived from his pubkey).

__quorum:__
the quorum of multi-signature accounts.

__memo_key:__
the memo_key required for Steem account. (hex)

example of `signers_proposed.txt`:
```
{
  "signers": {
    "rLSQVWfU2ZzCyRTKXUa6oHKbQ225uVrwD1": {
      "weight": 1,
      "pubkey": "0234c6ef8cafb7756094be00c08ad057193a07f34628322309c4e3e571e7e68709"
    },
    "r4kfBWgCTcvJxWbj1w6UZPbGa4PWeNaNqX": {
      "weight": 1,
      "pubkey": "029A3FD6E3EF8D786AFBFCE0D1AB060D2771610BB8305A73F4E62C59AA02814E23"
    },
    "rL9moEqRFJp7r1BXcQ6BXu4rtNo2U3Cp7s": {
      "weight": 1,
      "pubkey": "02E85606581246829F4AD992961816819E44B6CED0E83C4B824EFA16A631013439"
    },
    "rnt8KdAo9CDUPzyJZszeCogxwFRtniomN3": {
      "weight": 1,
      "pubkey": "0360cdd625a07404206165449bca9f58705d7a042c249c40386adfb2515b72293a"
    },
    "r9BLkJQyJ22si2RgKv9HpUcuAN2g9sqh3b": {
      "weight": 1,
      "pubkey": "037fe85ce6f832543bbc1705752d41e8d9eb507029ab8af0a0af494fef4243b405"
    }
  },
  "quorum": 3,
  "memo_key": "02db6da8dbb69151b04c72aef594d06700e8b4adc122c7c5bc851280d3f45d1fab"
}
```

Note: signers listed in the file must be sorted by pubkeys in ascending order.


## Change of Issuing Account's Settings:
File `accountset_proposed.txt` is to propose any change on gateway's issuing account. 

the JSON object in the file might contain one/more of the following fields: 
* Domain, 
* EmailHash, 
* MessageKey, 
* TransferRate, 
* SetFlag, 
* ClearFlag.

an example `accountset_proposed.txt` for changing the transfer_rate to 0.2%.
```
{
  "TransferRate": 1002000000
}
```

## Changes of TrustLimit between Issuing-Account and Hotwallet.
`trusts_proposed.txt` might contain a JSON with currency as _keys_ and trustlimit as _values_.

e.g.
```
{
  "USD": 1000000,
  "STM": 10000000
}
```
