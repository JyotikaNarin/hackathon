public with sharing class LeadScoringService {
    public static Integer score(Lead lead) {
        Integer score = 0;
        if (lead.Industry == 'Technology') score += 20;
        if (lead.NumberOfEmployees != null && lead.NumberOfEmployees > 500) score += 40;
        if (String.isNotBlank(lead.Email)) score += 10;
        return score;
    }
}
