public with sharing class LeadScoringService {
    public static Integer score(Lead lead) {
        Integer score = 0;
        if (lead.Industry == 'Technology' || lead.Industry == 'Finance') score += 25;
        if (lead.NumberOfEmployees != null && lead.NumberOfEmployees > 500) score += 30;
        return score;
    }
}
