@IsTest
private class AccountServiceTest {
    @IsTest
    static void creditLimitIsTenPercentOfRevenue() {
        Account acct = new Account(Name = 'Acme', AnnualRevenue = 1000);
        Assert.areEqual(100, AccountService.creditLimitFor(acct));
    }
}
