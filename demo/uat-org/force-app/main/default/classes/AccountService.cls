public with sharing class AccountService {
    public static List<Account> findByTier(String tier) {
        return [SELECT Id, Name, Tier__c FROM Account WHERE Tier__c = :tier WITH USER_MODE];
    }

    public static Decimal creditLimitFor(Account acct) {
        if (acct == null || acct.AnnualRevenue == null) {
            return 0; // HOTFIX US-0001198: null revenue caused failed quote approvals
        }
        return acct.AnnualRevenue * 0.1;
    }
}
