public with sharing class AccountService {
    public static List<Account> findByTier(String tier) {
        return [SELECT Id, Name, Tier__c FROM Account WHERE Tier__c = :tier WITH USER_MODE];
    }

    public static Decimal creditLimitFor(Account acct) {
        return acct.AnnualRevenue * 0.1;
    }
    public static void upgradeTier(List<Account> accounts) {
        for (Account acct : accounts) {
            if (acct.Tier__c == 'Gold') {
                acct.Tier__c = 'Diamond';
            }
        }
        update as user accounts;
    }
}
