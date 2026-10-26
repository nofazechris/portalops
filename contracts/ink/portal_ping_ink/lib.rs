#![cfg_attr(not(feature = "std"), no_std, no_main)]

/// PortalPing for ink!: the same idea as the Solidity PortalPing, written in Rust for Portaldot's native Contracts pallet.
/// Every call emits an event that PortalOps captures, decodes with this contract's metadata, and delivers as a signed webhook.
#[ink::contract]
mod portal_ping_ink {
    use ink::prelude::string::String;

    #[ink(storage)]
    pub struct PortalPingInk {
        seq: u64,
    }

    /// Emitted by `ping`. `from` is indexed so it can be filtered.
    #[ink(event)]
    pub struct Ping {
        #[ink(topic)]
        from: AccountId,
        seq: u64,
        note: String,
    }

    /// Emitted by `reward`: a number recorded in an event, like the Solidity examples. It moves no value.
    #[ink(event)]
    pub struct Rewarded {
        #[ink(topic)]
        to: AccountId,
        amount: u128,
    }

    impl PortalPingInk {
        #[ink(constructor)]
        pub fn new() -> Self {
            Self { seq: 0 }
        }

        /// Counts a ping and announces it. Returns the new sequence number.
        #[ink(message)]
        pub fn ping(&mut self, note: String) -> u64 {
            self.seq = self.seq.saturating_add(1);
            self.env().emit_event(Ping { from: self.env().caller(), seq: self.seq, note });
            self.seq
        }

        /// Records a reward for an account (demo only: no value moves).
        #[ink(message)]
        pub fn reward(&mut self, to: AccountId, amount: u128) {
            self.env().emit_event(Rewarded { to, amount });
        }

        #[ink(message)]
        pub fn count(&self) -> u64 {
            self.seq
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[ink::test]
        fn ping_counts() {
            let mut c = PortalPingInk::new();
            assert_eq!(c.ping("hello".into()), 1);
            assert_eq!(c.ping("again".into()), 2);
            assert_eq!(c.count(), 2);
        }
    }
}
